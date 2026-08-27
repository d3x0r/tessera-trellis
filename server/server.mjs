/**
 * @fileoverview Entry point. The protocol IS the HTTP+WS server.
 *
 *   /         runtime  (renders a document)
 *   /editor.html       designer (renderer + overlay)
 */

import { sack } from "sack.vfs";
import { config, port, CONFIG_FILE, PROGRAM_NAME } from "./config.mjs";
import { ensureSingleInstance } from "./singleton.mjs";
import { existsSync } from "node:fs";

/*
 * First, before anything else can create the event.
 *
 * GetProgramName() otherwise yields "node" -- argv[0] stripped of path and
 * extension -- which every node process on the machine shares, leaving the
 * sender to guess. Naming ourselves means singleton.mjs can signal a constant.
 */
sack.system.programName = PROGRAM_NAME;

if( !await ensureSingleInstance( port ) ) {
	console.log( "another instance owns the port; exiting" );
	process.exit( 1 );
}

/*
 * Imported only once the port is ours.  Importing protocol.mjs opens the
 * database, and opening it while another instance still holds its transaction
 * is the deadlock ensureSingleInstance() exists to prevent -- so this has to
 * be a dynamic import rather than a static one at the top.
 */
const { start } = await import( "./protocol.mjs" );
const { closeDatabase } = await import( "./db.mjs" );

/*
 * Answer the stop signal a replacing instance sends, so a handover commits the
 * open transaction instead of losing it.  Without this the replacement has to
 * escalate to a hard kill, and whatever autoTransact had not yet committed
 * goes with it.
 */
sack.system.enableExitSignal( () => {
	console.log( "stop requested; committing and exiting" );
	closeDatabase();
	process.exit( 0 );
} );

// Plugins register their actions and sources before the port opens.
const { protocol, plugins } = await start();

console.log( "config:", existsSync( CONFIG_FILE ) ? CONFIG_FILE : "(defaults)" );
console.log( "plugins:", !Array.isArray( config.plugins ) ? "* (all found)"
	: config.plugins.length ? config.plugins.join( ", " ) : "(none)" );
if( plugins.length ) console.log( "server halves loaded:", plugins.join( ", " ) );

console.log( "Tessera Trellis on http://localhost:" + port );
console.log( "  runtime  /" );
console.log( "  designer /editor.html" );

export { protocol };
