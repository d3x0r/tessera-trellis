/**
 * @fileoverview Security providers.
 *
 * ## The contract is the verdict, not the vocabulary
 *
 * Different logins do not share a permission model, and should not be made to.
 * A user database thinks in roles; an employee/player split thinks in whether
 * you are staff at all and at what level; something else will think in per-site
 * grants. Forcing all of them through one `tokens: []` list would mean every
 * provider inventing an encoding of its real model into strings, and the
 * document storing something none of them actually means.
 *
 * So a requirement is **namespaced by provider**, and only that provider reads
 * its own slice:
 *
 *   control.security = {
 *       "user-database": { roles: [ "manager" ] },
 *       "gameproxy":     { staff: true, minLevel: 3 },
 *   }
 *
 * This is the C original's shape, which already had it right:
 * `AddSecurityContextToken( object, module, token )` and
 * `GetSecurityContextTokens( object, module, list )` were namespaced by MODULE.
 *
 * The only thing every provider must agree on is the answer: given its own
 * slice and the session, allowed or not.
 *
 * ## Combination is AND, across providers
 *
 * A control is usable when EVERY provider named in its requirement allows it.
 * That way adding a requirement can only ever restrict, which is the property
 * you want when several plugins each guard a different concern.
 *
 * OR is deliberately not expressible across providers -- it belongs *inside* a
 * provider, which is the only layer that understands its own vocabulary well
 * enough to know what "either of these" means.
 *
 * ## Unknown providers fail CLOSED
 *
 * A requirement naming a provider that is not loaded denies. A document that
 * asks for a check nobody can perform has not been satisfied, and treating a
 * missing plugin as permission would make disabling a plugin a way to unlock
 * everything it guarded.
 *
 * ## This layer is an affordance; the server decides
 *
 * The C version ran locally and trusted, so hiding a control was enough. Here
 * the server must filter denied controls out of the document before sending it
 * and reject ops that touch them -- see server/security.mjs, which implements
 * the same rules against the same shape. A client-side check only avoids
 * drawing something the session could not use anyway.
 */

/** @type {Map<string,object>} */
const providers = new Map();

/**
 * @param {string} name  the key this provider reads out of a requirement
 * @param {object} provider
 * @param {(requirement:any, session:object)=>boolean} provider.test  required
 * @param {string} [provider.label]                  shown in the editor
 * @param {(requirement:any)=>string} [provider.describe]  one-line summary
 * @param {Function} [provider.edit]                 builds an editor for a slice
 */
export function registerSecurityProvider( name, provider ) {
	if( typeof provider.test !== "function" )
		throw new Error( `security provider '${name}' has no test()` );
	providers.set( name, provider );
}

export function getSecurityProvider( name ) { return providers.get( name ); }
export function providerNames() { return [ ...providers.keys() ].sort(); }

/**
 * Normalise a requirement to the namespaced shape.
 *
 * A bare `{ tokens: [...] }` is read as the built-in "tokens" provider's slice,
 * so documents written before providers were namespaced keep working.
 *
 * @returns {?Object<string,any>} null when nothing is required
 */
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
 * May this session use the thing carrying `security`?
 *
 * @param {?object} security  a control's or page's requirement
 * @param {object} [session]  whatever the connection authenticated as
 */
export function testSecurity( security, session ) {
	const need = requirementsOf( security );
	if( !need ) return true;

	for( const [ name, requirement ] of Object.entries( need ) ) {
		const provider = providers.get( name );
		if( !provider ) {
			console.warn( `security: no provider '${name}'; denying` );
			return false;                       // fail closed
		}
		if( !provider.test( requirement, session || {} ) ) return false;
	}
	return true;
}

/** One line per provider, for the property panel. */
export function describeSecurity( security ) {
	const need = requirementsOf( security );
	if( !need ) return [];
	return Object.entries( need ).map( ( [ name, requirement ] ) => {
		const provider = providers.get( name );
		if( provider && typeof provider.describe === "function" )
			return `${provider.label || name}: ${provider.describe( requirement )}`;
		return `${name}: ${JSON.stringify( requirement )}`;
	} );
}

/*
 * The built-in: a flat token list, which is what the seed documents use and
 * what a simple deployment wants. It is a provider like any other -- there is
 * no privileged model.
 */
registerSecurityProvider( "tokens", {
	label: "Tokens",
	test( requirement, session ) {
		const need = Array.isArray( requirement ) ? requirement : requirement.tokens;
		if( !need || !need.length ) return true;
		const have = ( session && session.tokens ) || [];
		return need.every( token => have.includes( token ) );
	},
	describe( requirement ) {
		const need = Array.isArray( requirement ) ? requirement : requirement.tokens;
		return ( need || [] ).join( ", " ) || "(none)";
	},
} );
