/**
 * @fileoverview Security, server side — the authoritative half.
 *
 * Same shape and same rules as ui/core/security.js (namespaced by provider,
 * AND across providers, unknown provider denies), deliberately a separate
 * module rather than a shared import: the client copy is an affordance that
 * only avoids drawing what a session could not use, and this one decides. They
 * must agree on the *shape*; they must not be able to be confused for each
 * other.
 *
 * A plugin's SERVER half registers the real check here; its client half may
 * register a cheaper approximation there, or none at all. A control the client
 * happens to draw is still refused when pressed.
 */

/** @type {Map<string,object>} */
const providers = new Map();

/**
 * @param {string} name
 * @param {{test:(requirement:any, session:object)=>boolean, label?:string}} provider
 */
export function registerSecurityProvider( name, provider ) {
	if( typeof provider.test !== "function" )
		throw new Error( `security provider '${name}' has no test()` );
	providers.set( name, provider );
}

export function providerNames() { return [ ...providers.keys() ].sort(); }

/** Namespaced requirements, treating a bare token list as the "tokens" slice. */
export function requirementsOf( security ) {
	if( !security ) return null;
	const out = {};
	for( const [ key, value ] of Object.entries( security ) ) {
		if( key === "tokens" ) {
			if( Array.isArray( value ) && value.length ) out.tokens = value;
		} else if( value !== undefined && value !== null ) out[ key ] = value;
	}
	return Object.keys( out ).length ? out : null;
}

/**
 * @param {?object} security
 * @param {object} session
 * @returns {boolean}
 */
export function allows( security, session ) {
	const need = requirementsOf( security );
	if( !need ) return true;

	for( const [ name, requirement ] of Object.entries( need ) ) {
		const provider = providers.get( name );
		// Fail closed: a check nobody can perform has not been satisfied, and
		// treating an unloaded plugin as permission would make disabling it a
		// way to unlock everything it guarded.
		if( !provider ) return false;
		if( !provider.test( requirement, session || {} ) ) return false;
	}
	return true;
}

/**
 * A copy of `canvas` with everything this session may not see removed.
 *
 * This is the part that makes security real rather than cosmetic. Hiding a
 * control in the browser stops it being drawn; it does nothing about a client
 * that reads the document off the wire. So a denied control must never be in
 * what we send.
 *
 * Structural, not a deep clone: pages and controls are rebuilt as plain data
 * for serialisation, so the server's own cached model is untouched and stays
 * authoritative for resolving a later invoke.
 *
 * @param {object} canvas   a parsed Canvas
 * @param {object} session
 * @param {Function} stringify  document.js's stringify
 * @returns {string} the snapshot to send
 */
export function filteredSnapshot( canvas, session, stringify ) {
	const keptPages = [];
	const dropped = [];

	const keepControls = ( page ) => {
		const kept = page.controls.filter( c => {
			if( allows( c.security, session ) ) return true;
			dropped.push( c.id );
			return false;
		} );
		return kept;
	};

	// Snapshot what we are about to change so the cached model survives intact.
	const originals = new Map();
	for( const page of canvas.pages ) originals.set( page, page.controls );
	if( canvas.shared ) originals.set( canvas.shared, canvas.shared.controls );

	try {
		for( const page of canvas.pages ) {
			if( !allows( page.security, session ) ) { keptPages.push( page ); continue; }
			page.controls = keepControls( page );
		}
		if( canvas.shared ) canvas.shared.controls = keepControls( canvas.shared );

		/*
		 * A page the session may not open is emptied rather than removed: a
		 * button elsewhere may still name it, and a missing page turns a denial
		 * into a broken navigation. Empty and denied is honest; absent is not.
		 */
		for( const page of keptPages ) page.controls = [];

		return { snapshot: stringify( canvas ), dropped };
	} finally {
		for( const [ page, controls ] of originals ) page.controls = controls;
	}
}

/** The default: a flat token list. A provider like any other. */
registerSecurityProvider( "tokens", {
	label: "Tokens",
	test( requirement, session ) {
		const need = Array.isArray( requirement ) ? requirement : requirement.tokens;
		if( !need || !need.length ) return true;
		const have = ( session && session.tokens ) || [];
		return need.every( token => have.includes( token ) );
	},
} );
