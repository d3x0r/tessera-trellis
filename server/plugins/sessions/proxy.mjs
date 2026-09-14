/**
 * @fileoverview Tell the game proxy that sessions changed.
 *
 * The plugin writes game_sessions directly; the proxy reads the same table
 * but keeps its session list in memory and hands it to the caller and floor
 * screens, so a day created here would not show on them until something
 * made the proxy re-read.  Its ServiceProxy protocol -- the backchannel
 * external services already use for logins -- accepts {op:"refreshSessions"}
 * for exactly that, and the proxy then broadcasts the new list itself.
 *
 * Never blocks and never fails a write: a proxy that is down just does not
 * hear about it, and re-reads on its own next time it refreshes.  One socket,
 * opened on first use, reopened on demand after it drops.
 */

import { sack } from "sack.vfs";

const JSOX = sack.JSOX;
const WebSocket = sack.WebSocket.Client;

/**
 * @param {object} opts
 * @param {string} opts.url        the proxy's websocket, e.g. ws://localhost:8087/
 * @param {(...a)=>void} [opts.log]
 */
export function createProxyNotifier( { url, log = () => {} } ) {
	let ws = null;
	let opening = null;
	let warned = false;

	function open() {
		if( ws ) return Promise.resolve( ws );
		if( opening ) return opening;
		opening = new Promise( ( res ) => {
			let sock;
			try { sock = new WebSocket( url, "ServiceProxy" ); }
			catch( err ) { opening = null; res( null ); return; }
			const giveUp = setTimeout( () => { opening = null; try { sock.close(); } catch( e ) { /* */ } res( null ); }, 3000 );
			sock.onopen = () => { clearTimeout( giveUp ); ws = sock; opening = null; warned = false; log( "game proxy backchannel open:", url ); res( sock ); };
			sock.onmessage = ( buffer ) => {
				let msg; try { msg = JSOX.parse( buffer ); } catch( err ) { return; }
				if( msg && msg.op === "error" && !warned ) {
					warned = true;
					log( "game proxy answered:", msg.reason, msg.was ? "(" + msg.was + ")" : "",
					     "- an older proxy without refreshSessions; restart it to pick the op up" );
				}
			};
			sock.onclose = () => { if( ws === sock ) ws = null; clearTimeout( giveUp ); if( opening ) { opening = null; res( null ); } };
			sock.onerror = () => { /* onclose follows */ };
		} );
		return opening;
	}

	return {
		/** Ask the proxy to re-read its session list; resolves false when it could not be told. */
		async refreshSessions( sessionId ) {
			if( !url ) return false;
			const sock = await open();
			if( !sock ) { if( !warned ) { warned = true; log( "game proxy not reachable at", url, "- it will learn of session changes on its own next refresh" ); } return false; }
			try { sock.send( JSOX.stringify( { op: "refreshSessions", sessionId: sessionId || 0 } ) ); return true; }
			catch( err ) { ws = null; return false; }
		},
		close() { if( ws ) { try { ws.close(); } catch( e ) { /* */ } ws = null; } },
	};
}
