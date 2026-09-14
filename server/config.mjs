/**
 * @fileoverview Service configuration.
 *
 * `config.jsox` at the service root; `TT_CONFIG` overrides the path.  The file
 * is optional -- the defaults are exactly what the service did before there was
 * a config, so an existing checkout keeps working untouched.
 *
 * Read and parsed rather than `import cfg from "config.jsox"`: a missing or
 * malformed file has to fall back to defaults, and a failed import cannot.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JSOX } from "jsox";

const here = dirname( fileURLToPath( import.meta.url ) );
const root = resolve( here, ".." );

const DEFAULTS = {
	port: 8099,
	/** "*" loads every plugin found on disk; an array selects them explicitly. */
	plugins: "*",
	/*
	 * Shared secret for the `expect` op -- the backchannel a login server uses
	 * to mint a session ticket.  DELIBERATELY absent from the defaults: with no
	 * value the op refuses every call, so a deployment that has not thought
	 * about it is not one where reaching the port is enough to mint a session.
	 * Set it in config.jsox on both this service and whoever calls it, and keep
	 * it out of anything served to a browser.
	 *
	 *   expectSecret: "...",
	 */
};

/**
 * The name this process answers stop signals under.
 *
 * On Windows a stop signal is delivered through CreateNamedEvent, whose name
 * is built from GetProgramName().  That defaults to argv[0] with the path and
 * extension stripped -- "node" -- so by default every node process on the
 * machine shares one name, and the sender has to guess it correctly.  Setting
 * it explicitly makes both halves agree on a constant instead: the server sets
 * it on itself, and singleton.mjs signals the same string.
 *
 * Must be assigned before enableExitSignal(), which creates the event.
 */
export const PROGRAM_NAME = "Tessera Trellis Server";

export const CONFIG_FILE = process.env.TT_CONFIG || resolve( root, "config.jsox" );

function load() {
	if( !existsSync( CONFIG_FILE ) ) return { ...DEFAULTS };
	try {
		return { ...DEFAULTS, ...JSOX.parse( readFileSync( CONFIG_FILE, "utf8" ) ) };
	} catch( err ) {
		console.log( `config ${CONFIG_FILE} unreadable, using defaults:`, err.message );
		return { ...DEFAULTS };
	}
}

export const config = load();

/**
 * Rewrite just the `plugins` array in config.jsox.
 *
 * A surgical replacement rather than JSOX.stringify of the whole object: the
 * file is hand-editable and carries comments explaining the options, and
 * re-serialising it would silently throw them away.  Plugin names cannot
 * contain a bracket, so matching to the first `]` is safe.
 *
 * @param {string[]} names
 * @returns {{ok:boolean, error?:string, file:string}}
 */
export function writeEnabledPlugins( names ) {
	const list = names.length
		? "[\n" + names.map( n => `\t\t${JSON.stringify( n )},` ).join( "\n" ) + "\n\t]"
		: "[]";
	try {
		if( existsSync( CONFIG_FILE ) ) {
			const text = readFileSync( CONFIG_FILE, "utf8" );
			const pattern = /(\bplugins\s*:\s*)(\[[^\]]*\]|"\*"|'\*')/;
			if( pattern.test( text ) )
				writeFileSync( CONFIG_FILE, text.replace( pattern, `$1${list}` ) );
			else
				// No plugins key to replace; add one before the closing brace.
				writeFileSync( CONFIG_FILE,
					text.replace( /\}\s*$/, `\tplugins: ${list},\n}\n` ) );
		} else {
			writeFileSync( CONFIG_FILE,
				`{\n\tport: ${DEFAULTS.port},\n\tplugins: ${list},\n}\n` );
		}
		config.plugins = names.slice();
		return { ok: true, file: CONFIG_FILE };
	} catch( err ) {
		return { ok: false, error: err.message, file: CONFIG_FILE };
	}
}

/** PORT wins over the file, so one config can still run several instances. */
export const port = Number( process.env.PORT ) || Number( config.port ) || DEFAULTS.port;

export { root as SERVICE_ROOT };
