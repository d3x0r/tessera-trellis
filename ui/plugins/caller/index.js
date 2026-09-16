/**
 * @fileoverview sideplayr caller: the client half.
 *
 * The caller screen as trellis controls over a small component library:
 *
 *   caller/Connection   where the game proxy is; the socket's state
 *   caller/Sessions     the sessions the room can play
 *   caller/Games        the games of the session in play
 *   caller/Flashboard   the 75-ball board (click to call / uncall)
 *   caller/Ball View    the last ball, large, and the rack of balls before it
 *   caller/Ring Timer   countdown between calls
 *   caller/Pattern      the current game's pattern; click to change it
 *   caller/Presence     who else is calling in the room
 *   caller/Command      a button for one caller command, enabled by state
 *   caller/Verify       winner verification, shown while validating
 *
 * plus the %Caller ... display variables (see controls/connection.js) and a
 * client action per command for stock Buttons.
 *
 * Nothing here talks to this service's server half: the caller's data comes
 * down its own websocket to the game proxy (lib/connection.js), and the
 * board, queue, pattern and login pieces are imported cross-origin from the
 * proxy's /common tree.  The server half only seeds the "Caller" document.
 */

// A plugin carries its own styling, appended so it wins ties with the base sheet.
if( !document.getElementById( "tt-caller-styles" ) ) {
	const link = document.createElement( "link" );
	link.id = "tt-caller-styles";
	link.rel = "stylesheet";
	link.href = new URL( "./styles.css", import.meta.url ).href;
	document.head.appendChild( link );
}

import "./controls/connection.js";
import "./controls/board.js";
import "./controls/lists.js";
import "./controls/command.js";
import "./controls/verify.js";

export { state, caller, ready, configure } from "./lib/connection.js";
export { CallerState, COMMANDS } from "./lib/state.js";
export { Flashboard } from "./lib/flashboard.js";
export { BallView } from "./lib/ballView.js";
export { RingTimer } from "./lib/ringTimer.js";

/** The loader offers the trellis protocol; the caller has no use for it yet. */
export function useProtocol() {}
