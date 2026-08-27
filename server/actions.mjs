/**
 * @fileoverview Server actions — the authoritative half.
 *
 * THE SECURITY BOUNDARY IS THE SESSION, NOT THE MESSAGE.  The socket belongs to
 * a user who either may or may not do a thing; allowed() below is what enforces
 * that, and it would still be required if the client named actions directly.
 * Nothing here assumes a press "really happened".
 *
 * What resolving through the control adds is narrower, and worth having anyway:
 * the ARGUMENTS are the ones the designer set.  A button configured for
 * hall "BoulderStation" cannot be replayed against "Bellagio", so per-object
 * authorisation falls out of per-control access instead of needing a separate
 * permission model for every argument an action might take.  It also keeps the
 * wire small, and means adding a button never adds a protocol op.
 *
 * Press-time input (a typed field, a selected row) does cross the wire, because
 * it has to.  That is data to be validated against the action's input schema.
 */

import { JSOX } from "jsox";
import * as store from "./db.mjs";
import { allows } from "./security.mjs";

/** @type {Map<string,object>} */
const actions = new Map();

/**
 * @param {string} name
 * @param {{label?:string, args?:object, input?:object, tokens?:string[],
 *          run:(ctx:object)=>any}} def
 */
export function registerAction( name, def ) {
	if( actions.has( name ) )
		throw new Error( `server action '${name}' is already registered` );
	if( typeof def.run !== "function" )
		throw new Error( `server action '${name}' has no run()` );
	actions.set( name, def );
}

/** What the designer may offer. Schemas travel; run() never does. */
export function describeActions() {
	return [ ...actions ].map( ( [ name, def ] ) => ( {
		name,
		where: "server",
		label: def.label || name,
		args:  def.args  || {},
		input: def.input || {},
	} ) );
}

// -- document resolution --------------------------------------------------

/*
 * Parsing the stored snapshot per press would be wasteful, so keep the parsed
 * document per name.  Any write to the document must drop it -- see invalidate().
 */
const parsed = new Map();

export async function documentFor( name ) {
	if( parsed.has( name ) ) return parsed.get( name );
	const row = await store.findDocument( name );
	if( !row || !row.snapshot ) return null;

	// The document model is deliberately node-compatible so the server can hold
	// the same objects the client does, rather than a second parallel shape.
	const { parse } = await import( "../ui/core/document.js" );
	const canvas = parse( row.snapshot );
	parsed.set( name, canvas );
	return canvas;
}

export function invalidate( name ) {
	if( name ) parsed.delete( name );
	else parsed.clear();
}

// -- invocation -----------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.document
 * @param {string} opts.control   the id the client pressed
 * @param {object} opts.input     press-time values, untrusted
 * @param {object} opts.session   whatever the connection has authenticated as
 * @returns {Promise<{ok:boolean, error?:string, result?:any, broadcast?:object}>}
 */
export async function invokeControl( { document: docName, control: controlId,
                                       input, session } ) {
	const canvas = await documentFor( docName );
	if( !canvas ) return { ok: false, error: "no such document" };

	const control = canvas.controlById( controlId );
	if( !control ) return { ok: false, error: "no such control" };

	// The action and its arguments come from the document, never the client.
	const name = control.props && control.props.action;
	if( !name ) return { ok: false, error: "control has no action" };

	const def = actions.get( name );
	if( !def ) return { ok: false, error: `no server action '${name}'` };

	if( !allowed( control, def, session ) )
		return { ok: false, error: "denied" };

	const args = control.props.actionArgs || {};
	const clean = validate( def.input, input );

	try {
		const result = await def.run( { control, args, input: clean, session, canvas } );
		return Object.assign( { ok: true }, result && result.broadcast
			? { result: result.value, broadcast: result.broadcast }
			: { result } );
	} catch( err ) {
		console.log( `action '${name}' failed:`, err.message );
		return { ok: false, error: "action failed" };
	}
}

/**
 * Both the control's own requirement and the action's must pass.  A control the
 * session cannot see is a control it cannot press.
 *
 * Delegated to security.mjs so an action guarded by a plugin's own permission
 * model is checked by that plugin, not by a token comparison here that would
 * only understand one vocabulary.
 */
function allowed( control, def, session ) {
	if( !allows( control.security, session ) ) return false;
	// An action may guard itself; `tokens` is the built-in provider's slice.
	const own = def.security || ( def.tokens ? { tokens: def.tokens } : null );
	return allows( own, session );
}

/** Keep only declared keys, coerced to the declared type. */
function validate( schema, input ) {
	const out = {};
	if( !schema || !input ) return out;
	for( const [ key, spec ] of Object.entries( schema ) ) {
		if( !( key in input ) ) continue;
		const v = input[ key ];
		out[ key ] = spec.type === "number" ? Number( v )
		           : spec.type === "bool"   ? !!v
		           : String( v );
	}
	return out;
}

// -- demo actions ---------------------------------------------------------

/*
 * Stands in for the sort of thing link_state.isp did: flip durable state and
 * tell every connected window about it.
 */
const hallState = new Map();

registerAction( "enableParticipant", {
	label: "Enable participant",
	args:  { hall: { type: "string", label: "Hall name" } },
	run( { args } ) {
		const hall = args.hall || "(unnamed)";
		const now = !hallState.get( hall );
		hallState.set( hall, now );
		console.log( `hall ${hall} -> ${now ? "enabled" : "disabled"}` );
		return {
			value: { hall, enabled: now },
			// Every window showing this hall should update, not just the presser.
			broadcast: { op: "hallState", hall, enabled: now },
		};
	},
} );

registerAction( "echo", {
	label: "Echo (diagnostic)",
	args:  { note: { type: "string", label: "Note" } },
	input: { text: { type: "string", label: "Text" } },
	run( { args, input, control } ) {
		return { note: args.note || "", text: input.text || "",
		         from: control.id, at: new Date().toISOString() };
	},
} );

export { JSOX };
