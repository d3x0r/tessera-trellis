/**
 * The ticket seam over the actual wire.
 *
 * tt-session-test.mjs checks the store and the providers in-process; this one
 * boots a real server on its own port and plays both ends of the flow: a login
 * server calling expect(), and a browser presenting what it got back.
 *
 * It starts the server as a child with TT_CONFIG pointing at a config of its
 * own, so nothing here touches the checked-in config.jsox or the default port.
 */

import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sack } from "sack.vfs";

const JSOX = sack.JSOX;
const WebSocket = sack.WebSocket.Client;
const here = dirname( fileURLToPath( import.meta.url ) );

let pass = 0, fail = 0;
const check = ( n, c, x ) => c ? ( pass++, console.log( "  ok   " + n ) )
                               : ( fail++, console.log( "  FAIL " + n, x === undefined ? "" : x ) );

const PORT = 18100;
const SECRET = "test-secret-" + Math.random().toString( 36 ).slice( 2 );

const dir = mkdtempSync( join( tmpdir(), "tt-wire-" ) );
const cfg = join( dir, "config.jsox" );
writeFileSync( cfg, JSOX.stringify( {
	port: PORT,
	expectSecret: SECRET,
	plugins: [ "gameproxy" ],
} ), "utf8" );

const server = spawn( process.execPath,
	[ "--import", "sack.vfs/import", join( here, "server", "server.mjs" ) ],
	{ cwd: here, env: { ...process.env, TT_CONFIG: cfg, PORT: String( PORT ) },
	  stdio: [ "ignore", "pipe", "pipe" ] } );

let serverOut = "";
server.stdout.on( "data", d=>{ serverOut += d; } );
server.stderr.on( "data", d=>{ serverOut += d; } );

function listening( timeoutMs ) {
	const until = Date.now() + timeoutMs;
	return new Promise( ( res, rej )=>{
		( function poll() {
			if( /Tessera Trellis on http/.test( serverOut ) ) return res();
			if( server.exitCode !== null )
				return rej( new Error( "server exited " + server.exitCode + "\n" + serverOut ) );
			if( Date.now() > until )
				return rej( new Error( "server did not start\n" + serverOut ) );
			setTimeout( poll, 150 );
		} )();
	} );
}

/** One connection, with a send-and-await-op helper. */
function open() {
	return new Promise( ( res, rej )=>{
		const ws = new WebSocket( "ws://127.0.0.1:" + PORT, "tessera-trellis" );
		const pending = [];
		ws.onopen = ()=>res( {
			raw: ws,
			ask( msg, op ) {
				return new Promise( ( ok )=>{
					const timer = setTimeout( ()=>ok( { op: "(timeout)" } ), 4000 );
					pending.push( ( m )=>{
						if( m.op !== op ) return false;
						clearTimeout( timer );
						ok( m );
						return true;
					} );
					ws.send( JSOX.stringify( msg ) );
				} );
			},
			close() { try { ws.close(); } catch( err ) { /* already gone */ } },
		} );
		ws.onerror = ( e )=>rej( e );
		ws.onmessage = ( buf )=>{
			let m; try { m = JSOX.parse( buf ); } catch( err ) { return; }
			for( let i = 0; i < pending.length; i++ )
				if( pending[i]( m ) ) { pending.splice( i, 1 ); return; }
		};
	} );
}

try {
	await listening( 25000 );
	console.log( "-- the backchannel --" );

	const loginServer = await open();
	const held = { who: "Ann Youzer",
		gameproxy: { role: "Manager", room: "Bingo",
			permissions: [ "POS/Void Transaction" ] } };

	const wrong = await loginServer.ask(
		{ op: "expect", token: "x1", secret: "not-it", session: held }, "expected" );
	check( "a wrong secret is refused", wrong.ok === false, wrong );
	check( "and no ticket comes with the refusal", !wrong.ticket, wrong );

	const none = await loginServer.ask(
		{ op: "expect", token: "x2", session: held }, "expected" );
	check( "no secret at all is refused", none.ok === false, none );

	const bad = await loginServer.ask(
		{ op: "expect", token: "x3", secret: SECRET, session: "not an object" }, "expected" );
	check( "a session that is not an object is refused", bad.ok === false, bad );

	const good = await loginServer.ask(
		{ op: "expect", token: "x4", secret: SECRET, session: held }, "expected" );
	check( "the right secret mints a ticket", good.ok === true && !!good.ticket, good );
	check( "the reply carries an expiry", good.expires > Date.now(), good.expires );
	check( "the reply echoes its token", good.token === "x4", good.token );

	console.log( "-- the browser end --" );
	const browser = await open();

	const junk = await browser.ask( { op: "hello", token: "h0", ticket: "nonsense" }, "hello" );
	check( "an invented ticket is refused", junk.ok === false, junk );
	check( "and says nothing about why", junk.who === null && junk.reason === undefined, junk );

	const hello = await browser.ask(
		{ op: "hello", token: "h1", ticket: good.ticket }, "hello" );
	check( "a real ticket establishes the session", hello.ok === true, hello );
	check( "and names who arrived", hello.who === "Ann Youzer", hello.who );
	check( "the reply never lists what they may do",
		hello.permissions === undefined && hello.gameproxy === undefined, hello );

	console.log( "-- a ticket is spent --" );
	const second = await open();
	const replay = await second.ask(
		{ op: "hello", token: "h2", ticket: good.ticket }, "hello" );
	check( "replaying the redirect does not open a second session",
		replay.ok === false, replay );
	second.close();

	browser.close();
	loginServer.close();
} catch( err ) {
	fail++;
	console.log( "  FAIL harness:", err.message );
} finally {
	server.kill();
}

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
