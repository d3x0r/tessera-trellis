/**
 * @fileoverview Data sources — the mirror image of actions.
 *
 * A button sends; a list, a table, a receipt view, a search result receives.
 * Both are resolved the same way: the client says which control wants data,
 * and the server reads the source name and its design-time arguments out of
 * its own copy of the document.
 *
 * The session's permissions are the actual gate, exactly as with actions.  What
 * resolving through the control adds is that the *arguments* are the ones the
 * designer set -- a receipt list scoped to one till cannot be re-pointed at
 * another by a client that edits its own query.
 *
 * A source declares columns so a generic table control can render it without
 * anyone writing a control module per report.
 */

import * as store from "./db.mjs";

/** @type {Map<string,object>} */
const sources = new Map();

/**
 * @param {string} name
 * @param {{label?:string, args?:object, input?:object, tokens?:string[],
 *          columns?:{key:string,label:string,align?:string}[],
 *          run:(ctx:object)=>any}} def
 */
export function registerSource( name, def ) {
	if( sources.has( name ) )
		throw new Error( `source '${name}' is already registered` );
	if( typeof def.run !== "function" )
		throw new Error( `source '${name}' has no run()` );
	sources.set( name, def );
}

/** Schemas and columns travel so the designer can offer them; run() does not. */
export function describeSources() {
	return [ ...sources ].map( ( [ name, def ] ) => ( {
		name,
		label:   def.label || name,
		args:    def.args || {},
		input:   def.input || {},
		columns: def.columns || [],
	} ) );
}

export function getSource( name ) { return sources.get( name ); }

/**
 * @param {object} opts
 * @param {object} opts.canvas   the server's parsed document
 * @param {string} opts.control  which control is asking
 * @param {object} opts.input    runtime filters (a search box), untrusted
 * @param {object} opts.session
 */
export async function queryControl( { canvas, control: controlId, input, session } ) {
	const control = canvas && canvas.controlById( controlId );
	if( !control ) return { ok: false, error: "no such control" };

	const name = control.props && control.props.source;
	if( !name ) return { ok: false, error: "control has no source" };

	const def = sources.get( name );
	if( !def ) return { ok: false, error: `no source '${name}'` };

	const need = [].concat( control.security && control.security.tokens || [],
	                        def.tokens || [] );
	const have = ( session && session.tokens ) || [];
	if( need.length && !need.every( t => have.includes( t ) ) )
		return { ok: false, error: "denied" };

	try {
		const rows = await def.run( {
			control,
			args: control.props.sourceArgs || {},
			input: input || {},
			session,
		} );
		return { ok: true, columns: def.columns || [], rows: rows || [] };
	} catch( err ) {
		console.log( `source '${name}' failed:`, err.message );
		return { ok: false, error: "query failed" };
	}
}

// -- demo sources ---------------------------------------------------------

/* Stands in for a real till; the shape is what matters. */
const receipts = [
	{ id: 1041, till: "T1", when: "09:14", items: 3, total: 24.50, clerk: "ana" },
	{ id: 1042, till: "T1", when: "09:31", items: 1, total:  6.00, clerk: "ana" },
	{ id: 1043, till: "T2", when: "09:47", items: 7, total: 91.25, clerk: "bo"  },
	{ id: 1044, till: "T1", when: "10:02", items: 2, total: 13.75, clerk: "cy"  },
	{ id: 1045, till: "T2", when: "10:20", items: 5, total: 48.10, clerk: "bo"  },
];

registerSource( "receipts", {
	label: "Receipt list",
	// Fixed at design time: which till this list is for.
	args:  { till: { type: "string", label: "Till" } },
	// Supplied at run time by a search box, and filtered server-side.
	input: { clerk: { type: "string", label: "Clerk" } },
	columns: [
		{ key: "id",    label: "#" },
		{ key: "when",  label: "Time" },
		{ key: "items", label: "Items", align: "right" },
		{ key: "total", label: "Total", align: "right" },
		{ key: "clerk", label: "Clerk" },
	],
	run( { args, input } ) {
		return receipts
			.filter( r => !args.till || r.till === args.till )
			.filter( r => !input.clerk || r.clerk.includes( input.clerk ) );
	},
} );

registerSource( "documents", {
	label: "Stored documents",
	columns: [
		{ key: "name",         label: "Document" },
		{ key: "snapshot_seq", label: "Seq", align: "right" },
		{ key: "modified",     label: "Modified" },
	],
	async run() {
		return await store.listDocuments();
	},
} );
