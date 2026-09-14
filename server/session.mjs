/**
 * @fileoverview Sessions, and how a connection comes to have one.
 *
 * Split out of protocol.mjs because the WeakMap was private there and a login
 * has to be able to write to it. It sits beside security.mjs deliberately:
 * that module decides what a session may do, this one decides what a session
 * *is*, and neither should be reachable by guessing at the other's internals.
 *
 * ## Why redemption is not an action
 *
 * The obvious place for "log in" is `registerAction`, and it does not work.
 * An action receives a *copy* of the session, so it cannot replace it; and
 * `invoke` only accepts a control the loaded document wires, so a login action
 * could not run until a document had already been fetched — and `loadDocument`
 * is the very thing that filters on the session. The session has to exist
 * before the first document goes on the wire, which means at or just after
 * connect, which means here.
 *
 * ## The shape: a ticket, not a credential
 *
 * A provider does not verify a password. It redeems a **ticket** minted
 * elsewhere by whoever did the authenticating — the same flow
 * `@d3x0r/user-database-remote` uses: the login server calls `expect(user)` on
 * the service over a private backchannel, gets an opaque id back, and hands
 * that id to the browser along with where to connect. The browser presents it
 * and nothing else. So:
 *
 *   - no credential ever reaches this service, and none is stored here
 *   - the session arrives already resolved — employee, role, permissions —
 *     so security providers stay pure and this service needs no user database
 *   - the ticket is single use and short lived, which a durable credential
 *     (a sideplayr `PosToken`, say) is not, and must never be substituted for:
 *     a long-lived token in a redirect URL lands in history, referrer headers
 *     and every proxy log between here and there
 */

import sack from "sack.vfs";

/** @type {Map<string,object>} */
const providers = new Map();

/** Per-connection session state; the only thing security is allowed to trust. */
const sessions = new WeakMap();

/** The session a connection has before it has redeemed anything. */
export function anonymousSession() { return { tokens: [] }; }

/**
 * @param {string} name
 * @param {{redeem:(ticket:string)=>(object|null|Promise<object|null>), label?:string}} provider
 */
export function registerSessionProvider( name, provider ) {
	if( typeof provider.redeem !== "function" )
		throw new Error( `session provider '${name}' has no redeem()` );
	providers.set( name, provider );
}

export function sessionProviderNames() { return [ ...providers.keys() ].sort(); }

export function sessionOf( ws ) { return sessions.get( ws ) || anonymousSession(); }
export function attachSession( ws, session ) { sessions.set( ws, session ); }
export function startSession( ws ) { sessions.set( ws, anonymousSession() ); }
export function endSession( ws ) { sessions.delete( ws ); }

/**
 * Offer a ticket to every provider until one claims it.
 *
 * First non-null wins, and the winner's name is recorded on the session as
 * `via`, so a security provider can tell how a session was established without
 * every provider having to agree on a shape beyond that.
 *
 * A ticket nobody claims leaves the connection exactly as it was — anonymous.
 * It is NOT an error the client can distinguish from a wrong ticket: a caller
 * probing which of several logins a deployment runs should learn nothing from
 * the answer.
 */
export async function redeem( ws, ticket ) {
	if( !ticket || "string" !== typeof ticket ) return null;
	for( const [ name, provider ] of providers ) {
		let session = null;
		try {
			session = await provider.redeem( ticket );
		} catch( err ) {
			// a provider that throws denies; it must not decide for the others
			console.log( "session provider", name, "failed to redeem:", err );
			continue;
		}
		if( !session ) continue;
		if( !Array.isArray( session.tokens ) ) session.tokens = [];
		session.via = name;
		sessions.set( ws, session );
		return session;
	}
	return null;
}

/* -- the built-in ticket store -------------------------------------------
 *
 * The service side of `expect(user)`: whoever authenticated hands us the
 * session it wants us to hold, we return an opaque id, and the browser
 * presents that id and nothing else.
 *
 * Kept here rather than in a plugin because a plugin has no way to be called
 * from outside -- it can register actions, sources and providers, but not an
 * op -- and minting is the exact mirror of redeeming. A login plugin is then
 * only its security provider, which is a pure function over the session.
 */

/** @type {Map<string,{session:object, expires:number}>} */
const tickets = new Map();

/** Long enough to cross a redirect and a websocket open; not long enough to keep. */
export const DEFAULT_TICKET_TTL = 60000;

function sweep( now ) {
	for( const [ id, held ] of tickets )
		if( held.expires <= now ) tickets.delete( id );
}

/**
 * Mint a single-use ticket for a session someone else has already established.
 *
 * Swept lazily rather than on a timer: an interval would have to be unref'd to
 * avoid holding the process open, and a store that is only read when it is used
 * does not need one. An unclaimed ticket costs a map entry until the next call.
 */
export function issueTicket( session, ttl = DEFAULT_TICKET_TTL ) {
	const now = Date.now();
	sweep( now );
	const id = sack.Id();
	tickets.set( id, { session, expires: now + Math.max( 1000, ttl | 0 ) } );
	return { ticket: id, expires: now + ttl };
}

export function ticketCount() { sweep( Date.now() ); return tickets.size; }

/*
 * Registered like any other provider, so a deployment that authenticates some
 * other way can ignore it, and one that uses both gets whichever claims the
 * ticket first.
 */
registerSessionProvider( "ticket", {
	label: "Issued ticket",
	redeem( ticket ) {
		const now = Date.now();
		sweep( now );
		const held = tickets.get( ticket );
		if( !held ) return null;
		// single use: spent whether or not the caller does anything with it, so
		// a replay of a redirect URL cannot open a second session
		tickets.delete( ticket );
		if( held.expires <= now ) return null;
		return held.session;
	},
} );
