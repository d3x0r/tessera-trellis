/**
 * @fileoverview One instance per port.
 *
 * Two instances on one SQLite file wedge each other permanently, and the
 * symptom gives no hint of the cause: `autoTransact` holds a write transaction
 * open for the life of the process, and without a busy timeout the second
 * connection waits for the lock forever rather than failing.  The blocked
 * statement never settles, db.mjs's serial() queue never advances past it, and
 * every later request -- loadDocument included -- hangs behind it.  What you
 * see is a blank editor and "timed out waiting for document", with a perfectly
 * good document sitting in the file.
 *
 * db.mjs now sets WAL and a busy timeout, so contention degrades to an error
 * instead of a hang.  That is the safety net; this is the actual fix -- there
 * should not be a second instance to contend with.
 *
 * Whoever owns the port owns the database, so the port is the lock.  That is
 * one check rather than two, and it cannot disagree with itself the way a
 * separate lock file can after a hard kill.
 *
 * The stop signal is addressed to PROGRAM_NAME, which the server assigns to
 * itself at startup.  Without that both sides fall back to GetProgramName()'s
 * default of "node", shared by every node process on the machine -- which is
 * what made signalling unreliable.  An instance started before that constant
 * existed still listens as "node" and will not answer; escalation covers it.
 *
 * Same approach as the launcher service, minus its command-line matching: the
 * port is the thing that actually conflicts, and matching on args would also
 * stop an instance deliberately started on a different port.
 */

import { sack } from "sack.vfs";
import { PROGRAM_NAME } from "./config.mjs";

const POLL_MS = 250;
/** Polls to wait for a graceful stop before escalating. */
const POLL_LIMIT = 12;
/** How many times to escalate before giving up. */
const KILL_LIMIT = 2;

const sleep = ( ms ) => new Promise( r => setTimeout( r, ms ) );

/** PID listening on `port`, excluding ourselves, or 0. */
function holderOf( port, selfId ) {
	for( const entry of sack.Network.TCP.ports )
		if( entry.port === port && entry.pid !== selfId ) return entry.pid;
	return 0;
}

/**
 * The binary name to address a stop signal to.
 *
 * NOTE: this is not what names the signal -- PROGRAM_NAME is.  The event name
 * comes from the target's GetProgramName(), which is why both halves set and
 * send the same constant.  This only identifies the executable.
 *
 * Still prefer `binary` over `bin`: `bin` is however the process was *invoked*,
 * and one node executable appears here under four spellings ("node.exe",
 * "..\node\node", "M:\...\node\node.exe", "C:\Users\...\node.exe"), whereas
 * `binary` is the canonical device path and is the same for all of them.
 */
function binaryOf( pid ) {
	try {
		for( const task of sack.Task.getProcessList( "node" ) )
			if( task.id === pid ) return task.binary || task.bin || "node.exe";
	} catch( err ) {
		console.log( "could not read the process list:", err.message );
	}
	return "node.exe";
}

/**
 * Make sure nothing else holds `port`, stopping it if it does.
 *
 * MUST run before anything opens the database -- which is why server.mjs
 * imports protocol.mjs dynamically, after awaiting this.
 *
 * @param {number} port
 * @returns {Promise<boolean>} true if the port is ours to bind
 */
export async function ensureSingleInstance( port ) {
	const selfId = sack.Task.processId();
	let holder = holderOf( port, selfId );
	if( !holder ) return true;

	const binary = binaryOf( holder );
	console.log( `port ${port} is held by pid ${holder} (${binary}); stopping it` );

	let kills = 0;
	for( let escalation = 0; escalation <= KILL_LIMIT; escalation++ ) {
		// Ask nicely the first time round, then insist.
		if( escalation === 0 ) sack.Task.stop( holder, 2, PROGRAM_NAME, binary );
		else { sack.Task.kill( holder ); kills++; }

		for( let poll = 0; poll < POLL_LIMIT; poll++ ) {
			await sleep( POLL_MS );
			const still = holderOf( port, selfId );
			if( !still ) {
				console.log( `port ${port} released${kills ? " (after kill)" : ""}` );
				return true;
			}
			/*
			 * A DIFFERENT pid means the old one died and something else took
			 * the port -- almost certainly a second copy of this service also
			 * starting up.  Stopping a stranger we never diagnosed is worse
			 * than declining to start.
			 */
			if( still !== holder ) {
				console.log( `port ${port} changed hands to pid ${still}; not starting` );
				return false;
			}
		}
		console.log( `pid ${holder} still holding port ${port}; escalating` );
	}

	console.log( `could not free port ${port} from pid ${holder}; not starting` );
	return false;
}
