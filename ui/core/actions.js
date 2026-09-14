/**
 * @fileoverview Actions — what a button *does*.
 *
 * The C original fused behaviour to control type: OnCreateMenuButton("Quit POS")
 * was an entire module.  That is right for a Clock, whose behaviour *is* its
 * type, but it means fifty buttons need fifty modules, which would defeat the
 * point of having a designer.  So behaviour is also available as a named action
 * that any button can reference, chosen from a dropdown at design time.
 *
 * WHERE AN ACTION RUNS IS A SECURITY DECISION, NOT A CONVENIENCE ONE.
 *
 * The test is "if the client lied about this, would it matter?"
 *   - client: page changes, display variables, focus.  A round trip to change
 *     a page is absurd latency, and nothing is at stake if it is faked.
 *   - server: anything durable or privileged.  The client's security check is
 *     decoration; only the server's is enforcement.
 *
 * A server action is NOT invoked by name from the client.  The client sends
 * only which control was pressed; the server reads the action and its
 * arguments out of its own copy of the document.  See server/actions.mjs.
 */

/** @type {Map<string,object>} */
const actions = new Map();

/**
 * @param {string} name
 * @param {{where:"client"|"server", label?:string, args?:object,
 *          input?:object, run?:Function}} def
 *   args  - schema for values fixed at design time (stored in the document)
 *   input - schema for values gathered at press time (sent over the wire)
 *   run   - client actions only; server actions live in server/actions.mjs
 */
export function registerAction( name, def ) {
	if( actions.has( name ) )
		throw new Error( `action '${name}' is already registered` );
	if( def.where === "client" && typeof def.run !== "function" )
		throw new Error( `client action '${name}' has no run()` );
	actions.set( name, Object.assign( { where: "client" }, def ) );
}

export function getAction( name ) { return actions.get( name ); }

export function actionNames() { return [ ...actions.keys() ].sort(); }

/** Merge the server's action list in, so the designer can offer them. */
export function mergeServerActions( list ) {
	for( const def of list ) {
		if( actions.has( def.name ) ) continue;
		// No run(): a server action is never executed on this side.
		actions.set( def.name, Object.assign( { where: "server" }, def ) );
	}
}

/**
 * Fire whatever a control is wired to.
 *
 * @param {Control} control
 * @param {{view:object, element:HTMLElement, protocol?:object,
 *          input?:object}} ctx
 */
export function invoke( control, ctx ) {
	const props = control.props || {};
	// ctx.slot picks one of several named actions (props.actions[slot]);
	// without it the control's single `action` is meant.
	const name = ctx.slot ? ( props.actions || {} )[ ctx.slot ] : props.action;
	if( !name ) return null;

	const def = actions.get( name );
	if( !def ) {
		console.warn( `control ${control.id}: no action '${name}'` );
		return null;
	}

	if( def.where === "client" )
		return def.run( { control, args: ( ctx.slot ? ( props.actionsArgs || {} )[ ctx.slot ] : props.actionArgs ) || {}, ...ctx } );

	if( !ctx.protocol ) {
		console.warn( `action '${name}' is server-side but no protocol is connected` );
		return null;
	}

	/*
	 * Only the control id and any press-time input cross the wire.  The action
	 * name and its arguments are deliberately NOT sent -- the server reads
	 * those from the document so a client cannot name an action it was never
	 * given, or hand it arguments of its own choosing.
	 */
	return ctx.protocol.invoke( control.id, ctx.input || {}, ctx.slot );
}

// -- stock client actions -------------------------------------------------

registerAction( "none", {
	where: "client",
	label: "(nothing)",
	run() {},
} );

registerAction( "setPage", {
	where: "client",
	label: "Go to page",
	args: { page: { type: "page", label: "Page" } },
	run( { args, element } ) {
		if( !args.page ) return;
		element.dispatchEvent( new CustomEvent( "tt-navigate",
			{ bubbles: true, detail: { page: args.page } } ) );
	},
} );

registerAction( "setVariable", {
	where: "client",
	label: "Set a display variable",
	args: {
		name:  { type: "string", label: "Variable" },
		value: { type: "string", label: "Value" },
	},
	async run( { args } ) {
		const vars = await import( "./variables.js" );
		vars.setVariable( args.name, args.value );
	},
} );
