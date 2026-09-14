/** Session establishment: ticket redemption, provider order, failure shape. */
import { registerSessionProvider, sessionProviderNames, redeem, sessionOf
       , attachSession, startSession, endSession, anonymousSession
       , issueTicket, ticketCount }
	from "./server/session.mjs";
import { registerSecurityProvider, allows } from "./server/security.mjs";

let pass = 0, fail = 0;
const check = ( n, c, x ) => c ? ( pass++, console.log( "  ok   " + n ) )
                               : ( fail++, console.log( "  FAIL " + n, x === undefined ? "" : x ) );

// stand-ins for websockets; sessionOf keys off object identity
const ws  = { id: "a" };
const ws2 = { id: "b" };

console.log( "-- a connection starts anonymous --" );
startSession( ws );
check( "anonymous has an empty token list", sessionOf( ws ).tokens.length === 0 );
check( "an unknown socket is anonymous too", sessionOf( ws2 ).tokens.length === 0 );
check( "anonymous is a fresh object each time",
	anonymousSession() !== anonymousSession() );

console.log( "-- anonymous denies anything that asks --" );
registerSecurityProvider( "hall", {
	test: ( req, session ) => ( session.hall || {} ).role === req.role,
} );
check( "a requirement denies an anonymous session",
	!allows( { hall: { role: "manager" } }, sessionOf( ws ) ) );
check( "no requirement still allows", allows( null, sessionOf( ws ) ) );

console.log( "-- redemption --" );
const issued = new Map( [ [ "good-ticket",
	{ who: "Ann Youzer", hall: { role: "manager" }, tokens: [ "caller" ] } ] ] );
registerSessionProvider( "hall", {
	redeem( ticket ) {
		if( !issued.has( ticket ) ) return null;
		const session = issued.get( ticket );
		issued.delete( ticket );          // single use
		return session;
	},
} );
check( "the provider is listed", sessionProviderNames().includes( "hall" ) );

const session = await redeem( ws, "good-ticket" );
check( "a good ticket establishes a session", !!session, session );
check( "it is attached to that socket", sessionOf( ws ) === session );
check( "the winning provider is recorded", session.via === "hall", session.via );
check( "the other socket is untouched", sessionOf( ws2 ).tokens.length === 0 );
check( "security now passes", allows( { hall: { role: "manager" } }, sessionOf( ws ) ) );
check( "a requirement it does not meet still denies",
	!allows( { hall: { role: "auditor" } }, sessionOf( ws ) ) );

console.log( "-- a ticket is single use --" );
check( "the same ticket does not work twice", await redeem( ws2, "good-ticket" ) === null );
check( "and left that socket anonymous", sessionOf( ws2 ).tokens.length === 0 );

console.log( "-- nothing to redeem --" );
for( const bad of [ null, undefined, "", 0, {}, [], "no-such-ticket" ] ) {
	check( "refused: " + JSON.stringify( bad ), await redeem( ws2, bad ) === null );
}
check( "a refusal leaves the session as it was", sessionOf( ws2 ).tokens.length === 0 );

console.log( "-- a provider that throws denies, and does not stop the others --" );
registerSessionProvider( "broken", { redeem() { throw new Error( "backchannel is down" ); } } );
registerSessionProvider( "backup", {
	redeem: ( t ) => t === "backup-ticket" ? { who: "Sam Vimes", tokens: [] } : null,
} );
const viaBackup = await redeem( ws2, "backup-ticket" );
check( "a later provider still gets its turn", !!viaBackup, viaBackup );
check( "and is the one recorded", viaBackup && viaBackup.via === "backup", viaBackup && viaBackup.via );

console.log( "-- a session with no tokens key is still usable --" );
registerSessionProvider( "sparse", {
	redeem: ( t ) => t === "sparse-ticket" ? { who: "No Tokens" } : null,
} );
const sparse = await redeem( ws2, "sparse-ticket" );
check( "tokens is filled in", Array.isArray( sparse.tokens ) && sparse.tokens.length === 0 );
check( "the built-in token provider is satisfiable",
	allows( { tokens: [] }, sparse ) && !allows( { tokens: [ "x" ] }, sparse ) );

console.log( "-- explicit attach and close --" );
attachSession( ws2, { who: "Direct", tokens: [ "z" ] } );
check( "attachSession replaces it", sessionOf( ws2 ).who === "Direct" );
endSession( ws2 );
check( "close returns it to anonymous", sessionOf( ws2 ).tokens.length === 0
	&& sessionOf( ws2 ).who === undefined );

console.log( "-- the built-in ticket store --" );
const ws3 = { id: "c" };
const held = { who: "Ann Youzer", gameproxy: { role: "Manager", room: "Bingo",
	permissions: [ "POS/Void Transaction", "Caller/login" ] } };
const minted = issueTicket( held );
check( "a ticket is issued", !!minted.ticket && minted.ticket.length > 8, minted.ticket );
check( "with an expiry in the future", minted.expires > Date.now() );
check( "and is outstanding", ticketCount() >= 1, ticketCount() );

const redeemed = await redeem( ws3, minted.ticket );
check( "it redeems to the held session", redeemed && redeemed.who === "Ann Youzer", redeemed );
check( "via the ticket provider", redeemed.via === "ticket", redeemed.via );
check( "and is spent", await redeem( ws3, minted.ticket ) === null );

const brief = issueTicket( { who: "Expiring" }, 1000 );
check( "a short ttl is floored at a second, not zeroed", brief.expires - Date.now() > 500 );
const past = issueTicket( { who: "Already gone" }, -1 );
check( "a negative ttl cannot mint something eternal",
	past.expires - Date.now() <= 1000 );

console.log( "-- the gameproxy provider is pure --" );
await import( "./server/plugins/gameproxy.mjs" );
const manager = redeemed;
const anon = anonymousSession();

check( "a held permission allows",
	allows( { gameproxy: { module: "POS", permission: "Void Transaction" } }, manager ) );
check( "an unheld permission denies",
	!allows( { gameproxy: { module: "POS", permission: "Refund" } }, manager ) );
check( "an empty requirement allows", allows( { gameproxy: {} }, manager ) );
check( "an empty requirement allows even anonymous", allows( { gameproxy: {} }, anon ) );
check( "any requirement denies anonymous",
	!allows( { gameproxy: { module: "Caller", permission: "login" } }, anon ) );

check( "role list ORs inside the provider",
	allows( { gameproxy: { role: [ "Manager", "Supervisor" ] } }, manager ) );
check( "a role it does not have denies",
	!allows( { gameproxy: { role: [ "Auditor" ] } }, manager ) );
check( "room pins a control to one room",
	allows( { gameproxy: { room: "Bingo" } }, manager )
	&& !allows( { gameproxy: { room: "Testing" } }, manager ) );
check( "fields AND: right role, wrong permission still denies",
	!allows( { gameproxy: { role: "Manager", module: "POS", permission: "Refund" } }, manager ) );
check( "a permissions list needs all of them",
	allows( { gameproxy: { permissions: [ "Caller/login", "POS/Void Transaction" ] } }, manager )
	&& !allows( { gameproxy: { permissions: [ "Caller/login", "Floor/login" ] } }, manager ) );

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
