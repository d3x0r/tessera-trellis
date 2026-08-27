/** Server-side security: namespaced providers, AND, fail-closed, filtering. */
import { Canvas, Page, Control, stringify, parse } from "./ui/core/document.js";
import { registerControl } from "./ui/core/registry.js";
import { registerSecurityProvider, allows, requirementsOf, filteredSnapshot }
	from "./server/security.mjs";

registerControl( "Button", { properties: {}, create() {} } );

let pass = 0, fail = 0;
const check = ( n, c, x ) => c ? ( pass++, console.log( "  ok   " + n ) )
                               : ( fail++, console.log( "  FAIL " + n, x === undefined ? "" : x ) );

// Two providers with genuinely different permission models.
registerSecurityProvider( "userdb", {
	test: ( req, session ) => ( req.roles || [] )
		.every( r => ( ( session.userdb && session.userdb.roles ) || [] ).includes( r ) ),
} );
registerSecurityProvider( "gameproxy", {
	// Not a token list at all: staff flag plus a numeric level.
	test: ( req, session ) => {
		const s = session.gameproxy || {};
		if( req.staff && !s.staff ) return false;
		return ( s.level || 0 ) >= ( req.minLevel || 0 );
	},
} );

console.log( "-- no requirement --" );
check( "null security allows", allows( null, {} ) );
check( "empty object allows", allows( {}, {} ) );
check( "empty token list allows", allows( { tokens: [] }, {} ) );

console.log( "-- the built-in token provider still works --" );
check( "matching tokens allow",
	allows( { tokens: [ "a" ] }, { tokens: [ "a", "b" ] } ) );
check( "missing token denies", !allows( { tokens: [ "c" ] }, { tokens: [ "a" ] } ) );

console.log( "-- providers keep their own vocabulary --" );
check( "roles model allows",
	allows( { userdb: { roles: [ "manager" ] } }, { userdb: { roles: [ "manager" ] } } ) );
check( "roles model denies",
	!allows( { userdb: { roles: [ "manager" ] } }, { userdb: { roles: [ "clerk" ] } } ) );
check( "level model allows",
	allows( { gameproxy: { staff: true, minLevel: 3 } },
	        { gameproxy: { staff: true, level: 5 } } ) );
check( "level model denies on level",
	!allows( { gameproxy: { staff: true, minLevel: 3 } },
	         { gameproxy: { staff: true, level: 1 } } ) );
check( "level model denies a non-employee",
	!allows( { gameproxy: { staff: true } }, { gameproxy: { level: 9 } } ) );

console.log( "-- AND across providers --" );
const both = { userdb: { roles: [ "manager" ] }, gameproxy: { minLevel: 2 } };
check( "both satisfied allows",
	allows( both, { userdb: { roles: [ "manager" ] }, gameproxy: { level: 2 } } ) );
check( "one unsatisfied denies",
	!allows( both, { userdb: { roles: [ "manager" ] }, gameproxy: { level: 1 } } ) );
check( "the other unsatisfied denies",
	!allows( both, { userdb: { roles: [ "clerk" ] }, gameproxy: { level: 9 } } ) );

console.log( "-- unknown providers fail CLOSED --" );
check( "an unloaded provider denies",
	!allows( { nosuchplugin: { anything: true } }, { nosuchplugin: { anything: true } } ) );
check( "...even for an otherwise-permitted session",
	!allows( { nosuchplugin: {}, tokens: [] }, { tokens: [ "everything" ] } ) );

console.log( "-- requirementsOf normalises --" );
check( "a bare token list becomes the tokens slice",
	JSON.stringify( requirementsOf( { tokens: [ "x" ] } ) ) === '{"tokens":["x"]}' );
check( "nulls drop out", requirementsOf( { userdb: null } ) === null );

console.log( "-- the snapshot actually withholds --" );
{
	const canvas = new Canvas( "Sec" );
	const page = canvas.addPage( new Page( "Main" ) );
	const open = page.add( new Control( "Button", 0, 0, 100, 100, { text: "open" } ) );
	const secret = page.add( new Control( "Button", 0, 0, 100, 100, { text: "secret" } ) );
	secret.security = { userdb: { roles: [ "manager" ] } };
	canvas.shared.add( new Control( "Button", 0, 0, 100, 100, { text: "bar" } ) );

	const clerk = { userdb: { roles: [ "clerk" ] } };
	const out = filteredSnapshot( canvas, clerk, stringify );
	check( "the denied control is reported", out.dropped.length === 1
		&& out.dropped[ 0 ] === secret.id, out.dropped );
	check( "its id is nowhere in the wire text", !out.snapshot.includes( secret.id ) );
	check( "and neither is its text", !out.snapshot.includes( "secret" ) );
	check( "the permitted control survives", out.snapshot.includes( "open" ) );
	check( "the shared layer survives", out.snapshot.includes( "bar" ) );

	// The server's own model must be untouched -- it resolves invokes from it.
	check( "the cached model still has both controls", page.controls.length === 2,
		page.controls.length );
	check( "the shared layer is intact too", canvas.shared.controls.length === 1 );

	const manager = { userdb: { roles: [ "manager" ] } };
	const full = filteredSnapshot( canvas, manager, stringify );
	check( "a permitted session gets everything", full.dropped.length === 0
		&& full.snapshot.includes( "secret" ) );

	// And it still parses.
	const back = parse( out.snapshot );
	check( "the filtered snapshot parses", back.pages[ 0 ].controls.length === 1,
		back.pages[ 0 ].controls.length );
}

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
