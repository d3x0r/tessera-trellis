/**
 * @fileoverview Server protocol.
 *
 * Document storage lives behind db.mjs; this module only serializes.  The
 * server is the source of truth for a document -- that is what makes several
 * editor windows possible without threading a page reference through the
 * client, the way the C multi-window branch had to.
 */

import sack from "sack.vfs";
import { Protocol as Protocol_ } from "sack.vfs/server-protocol";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as store from "./db.mjs";
import * as actions from "./actions.mjs";
import * as sources from "./sources.mjs";
import * as assets from "./assets.mjs";
import { filteredSnapshot } from "./security.mjs";
import { config, port, CONFIG_FILE, writeEnabledPlugins } from "./config.mjs";

const here = dirname( fileURLToPath( import.meta.url ) );
const root = resolve( here, ".." );

/** Connections, so an action can tell every window about a state change. */
const clients = new Set();
/** Per-connection session state; the only thing security is allowed to trust. */
const sessions = new WeakMap();

class Protocol extends Protocol_ {
	constructor() {
		super( {
			resourcePath: resolve( root, "ui" ),
			// Lets the importmap resolve /node_modules/jsox from the workspace root.
			npmPath: resolve( root, "..", ".." ),
			port,
		} );

		/*
		 * What may be placed.  The server owns this list because it will also
		 * need the schemas itself -- to validate ops, and to filter controls a
		 * session may not see before the document is ever sent.
		 */
		this.on( "listImages", ( ws ) => {
			ws.send( { op: "imageList", images: assets.listImages(),
			           limits: assets.limits() } );
		} );

		/*
		 * Image upload rides the existing socket: JSOX encodes a TypedArray, so
		 * there is no separate HTTP route to secure, and the reply carries the
		 * URL the file is already reachable at.
		 */
		this.on( "putImage", ( ws, msg ) => {
			const result = assets.putImage( msg.name, msg.data );
			ws.send( { op: "imageStored", token: msg.token, ...result } );
			if( result.ok )
				for( const peer of clients )
					if( peer !== ws )
						try { peer.send( { op: "imagesChanged" } ); } catch( err ) { clients.delete( peer ); }
		} );

		this.on( "removeImage", ( ws, msg ) => {
			const result = assets.removeImage( msg.url );
			ws.send( { op: "imageRemoved", token: msg.token, ...result } );
		} );

		this.on( "listPlugins", ( ws ) => {
			ws.send( { op: "pluginList", plugins: clientPlugins() } );
		} );

		/*
		 * Everything ON DISK plus whether it is enabled -- what the designer's
		 * plugin panel lists.  Distinct from listPlugins, which answers "what
		 * should this client import right now" and so only returns enabled
		 * client halves.
		 */
		this.on( "listAllPlugins", ( ws ) => {
			ws.send( { op: "allPluginList", plugins: describeAllPlugins(),
			           configFile: CONFIG_FILE } );
		} );

		/*
		 * Enable/disable, written back to config.jsox.
		 *
		 * Takes effect on RESTART, and cannot do otherwise: a server half is
		 * imported once at startup, and an ES module cannot be un-imported.
		 * Saying so is better than a panel that looks like it did something.
		 */
		this.on( "setPlugins", ( ws, msg ) => {
			const names = Array.isArray( msg.plugins ) ? msg.plugins : [];

			/*
			 * Only a SERVER half needs a restart -- it is imported once and an ES
			 * module cannot be un-imported.  A client half is fetched fresh by
			 * every page load, so enabling a client-only plugin takes effect on
			 * reload.  Saying "restart required" either way would train people to
			 * ignore it on the occasions it is true.
			 */
			const before = describeAllPlugins();
			const wanted = new Set( names );
			const restartRequired = before.some( p =>
				p.server && p.enabled !== wanted.has( p.name ) );

			const result = writeEnabledPlugins( names );
			if( result.ok ) {
				selected = null;            // recompute the selection on next use
				console.log( "plugins set to:", names.length ? names.join( ", " ) : "(none)" );
			}
			ws.send( { op: "pluginsSaved", ...result, restartRequired } );
		} );

		this.on( "listControls", ( ws ) => {
			ws.emit( "controlList", { modules: controlModules() } );
		} );

		this.on( "listSources", ( ws ) => {
			ws.send( { op: "sourceList", sources: sources.describeSources() } );
		} );

		/*
		 * The mirror of invoke: a list, table or search result asking for its
		 * data.  Resolved identically -- the client names a control, never a
		 * query, so the design-time arguments cannot be re-pointed.
		 */
		this.on( "query", async ( ws, msg ) => {
			const canvas = await actions.documentFor( msg.document );
			const result = await sources.queryControl( {
				canvas,
				control: msg.control,
				input:   msg.input,
				session: sessions.get( ws ) || {},
			} );
			ws.send( { op: "queried", token: msg.token, ...result } );
		} );

		this.on( "listActions", ( ws ) => {
			ws.send( { op: "actionList", actions: actions.describeActions() } );
		} );

		/*
		 * A button press.  Note what is NOT in this message: the action name and
		 * its arguments.  The client sends only which control it pressed; the
		 * server reads the rest out of its own copy of the document, so a client
		 * cannot invoke something it was never wired to, nor choose the
		 * arguments.  'input' is press-time data and is validated, not trusted.
		 */
		this.on( "invoke", async ( ws, msg ) => {
			const result = await actions.invokeControl( {
				document: msg.document,
				control:  msg.control,
				input:    msg.input,
				session:  sessions.get( ws ) || {},
			} );

			ws.send( { op: "invoked", token: msg.token,
			           ok: result.ok, error: result.error, result: result.result } );

			if( result.ok && result.broadcast )
				for( const peer of clients )
					try { peer.send( result.broadcast ); } catch( err ) { clients.delete( peer ); }
		} );

		this.on( "listDocuments", async ( ws ) => {
			ws.emit( "documentList", { documents: await store.listDocuments() } );
		} );

		/*
		 * Send only what this session may see.
		 *
		 * Hiding a control in the browser stops it being drawn and nothing
		 * more -- a client reading the document off the wire would still have
		 * it. So denied controls are removed from the snapshot here, which is
		 * what makes the client-side check an affordance rather than the
		 * defence.
		 *
		 * The editor asks for the document unfiltered, because you cannot edit
		 * what you cannot see; that request is itself a privileged one and is
		 * where an editing permission will attach.
		 */
		this.on( "loadDocument", async ( ws, msg ) => {
			const doc = await store.findDocument( msg.name );
			if( !doc || !doc.snapshot ) {
				ws.send( { op: "document", name: msg.name, snapshot: null, seq: 0 } );
				return;
			}

			let snapshot = doc.snapshot;
			let dropped = [];
			if( !msg.editing ) {
				const canvas = await actions.documentFor( msg.name );
				if( canvas ) {
					const { parse, stringify } = await import( "../ui/core/document.js" );
					void parse;
					const result = filteredSnapshot( canvas, sessions.get( ws ) || {}, stringify );
					snapshot = result.snapshot;
					dropped = result.dropped;
					if( dropped.length )
						console.log( `document ${msg.name}: withheld ${dropped.length}`
							+ " control(s) from this session" );
				}
			}

			ws.send( { op: "document", name: msg.name, snapshot,
			           seq: doc.snapshot_seq, withheld: dropped.length } );
		} );

		this.on( "saveDocument", async ( ws, msg ) => {
			let doc = await store.findDocument( msg.name );
			if( !doc ) doc = await store.createDocument( msg.name, msg.snapshot );
			else await store.saveSnapshot( doc.id, msg.snapshot, doc.snapshot_seq );
			actions.invalidate( msg.name );
			ws.send( { op: "saved", name: msg.name, id: doc.id } );
			console.log( "saved document", msg.name, msg.snapshot.length, "bytes" );
		} );

		this.on( "connect", ( ws ) => {
			clients.add( ws );
			// No authentication yet: an empty token set, which denies any
			// action or control that declares tokens.
			sessions.set( ws, { tokens: [] } );
			console.log( "client connected;", clients.size, "open" );
		} );

		this.on( "close", ( ws ) => {
			clients.delete( ws );
			sessions.delete( ws );
		} );
	}
}

/*
 * Plugins.
 *
 *   server/plugins/<name>.mjs    registers actions and sources; imported at
 *                                startup and NEVER served to a browser
 *   ui/plugins/<name>/index.js   registers controls, client actions, variables;
 *                                listed to clients, which import it before
 *                                anything renders
 *
 * The two halves are separate directories rather than one, so a plugin's
 * server code cannot be fetched over HTTP just because its client code must be.
 */

const SERVER_PLUGIN_DIR = resolve( root, "server", "plugins" );
const CLIENT_PLUGIN_DIR = resolve( root, "ui", "plugins" );

/*
 * Discovery runs through sack.Volume rather than node:fs.
 *
 * Same answers for a plain directory, and it also reads a container -- so a
 * packaged or encrypted deployment can ship its plugins inside one without
 * this code changing. `dir()` reports `folder` directly, which is the one
 * thing the layout below actually needs to know.
 */
const disk = sack.Volume();

/** Entries in a directory, without the "." and ".." the volume includes. */
function listing( path ) {
	try {
		return ( disk.dir( path ) || [] ).filter( e => e.name !== "." && e.name !== ".." );
	} catch( err ) {
		return [];
	}
}

/*
 * BOTH layouts are accepted, on BOTH halves:
 *
 *   plugins/<name>.mjs            a loader file, optionally beside a
 *   plugins/<name>/                 same-named directory of support classes
 *
 *   plugins/<name>/index.mjs      everything under one directory
 *
 * Symmetric on purpose. The two halves used to disagree -- server was a file,
 * client was a directory-with-index.js -- which meant a plugin's two halves
 * were laid out differently for no reason a plugin author could have guessed.
 *
 * A loader file WINS over a directory index, so `<name>.mjs` beside `<name>/`
 * loads the file and treats the directory purely as support code. That is the
 * case worth having: a login provider is a check, an approximation, a session
 * shape and a UI, which is more than one index file wants to hold.
 */
const SERVER_EXT = ".mjs";
const CLIENT_EXT = ".js";

function halfPath( dir, name, ext ) {
	const file = resolve( dir, name + ext );
	if( disk.exists( file ) ) return file;
	const index = resolve( dir, name, "index" + ext );
	if( disk.exists( index ) ) return index;
	return null;
}

const serverHalf = ( name ) => halfPath( SERVER_PLUGIN_DIR, name, SERVER_EXT );
const clientHalf = ( name ) => halfPath( CLIENT_PLUGIN_DIR, name, CLIENT_EXT );

const hasServerHalf = ( name ) => !!serverHalf( name );
const hasClientHalf = ( name ) => !!clientHalf( name );

/** Plugin names visible in a directory, by either layout. */
function namesIn( dir, ext ) {
	const found = new Set();
	for( const entry of listing( dir ) ) {
		if( entry.folder ) {
			if( disk.exists( resolve( dir, entry.name, "index" + ext ) ) ) found.add( entry.name );
		} else if( entry.name.endsWith( ext ) ) {
			found.add( entry.name.slice( 0, -ext.length ) );
		}
	}
	return found;
}

/**
 * Which plugins to load, and in what order.
 *
 * `config.plugins: "*"` (or no config file) scans the disk, which is what the
 * service did before there was a config.  An array selects explicitly and its
 * order is preserved, because registration order is observable -- a later
 * plugin can take an action or source name an earlier one registered.
 *
 * A plugin may be one-sided: server-only (an action provider with no UI of its
 * own) or client-only (controls needing no server).  A configured name that
 * matches neither half is a configuration error and says so, rather than being
 * silently skipped.
 */
function selectPlugins() {
	let names;
	if( config.plugins == null || config.plugins === "*" ) {
		const found = new Set( [ ...namesIn( SERVER_PLUGIN_DIR, SERVER_EXT ),
		                         ...namesIn( CLIENT_PLUGIN_DIR, CLIENT_EXT ) ] );
		names = [ ...found ].sort();
	} else if( Array.isArray( config.plugins ) ) {
		names = config.plugins;
	} else {
		console.log( `config plugins must be "*" or an array; loading none` );
		names = [];
	}

	const selected = [];
	for( const name of names ) {
		const server = hasServerHalf( name ), client = hasClientHalf( name );
		if( !server && !client ) {
			console.log( `plugin '${name}' is configured but has neither`
				+ ` server/plugins/${name}.mjs nor ui/plugins/${name}/index.js` );
			continue;
		}
		selected.push( { name, server, client } );
	}
	return selected;
}

let selected = null;
const plugins = () => selected || ( selected = selectPlugins() );

/** Import every enabled server half. Awaited before the port opens. */
export async function loadServerPlugins() {
	const loaded = [];
	for( const plugin of plugins() ) {
		if( !plugin.server ) continue;      // client-only; nothing to import here
		try {
			await import( pathToFileURL( serverHalf( plugin.name ) ).href );
			loaded.push( plugin.name );
		} catch( err ) {
			console.log( `plugin ${plugin.name} failed to load:`, err.message );
		}
	}
	return loaded;
}

/**
 * Every plugin on disk, with which halves it has and whether it is enabled.
 * @returns {Array<{name:string,server:boolean,client:boolean,enabled:boolean}>}
 */
export function describeAllPlugins() {
	const found = new Set( [ ...namesIn( SERVER_PLUGIN_DIR, SERVER_EXT ),
	                         ...namesIn( CLIENT_PLUGIN_DIR, CLIENT_EXT ) ] );

	const all = !Array.isArray( config.plugins );   // "*" enables everything
	const enabled = all ? null : new Set( config.plugins );
	return [ ...found ].sort().map( name => ( {
		name,
		server:  hasServerHalf( name ),
		client:  hasClientHalf( name ),
		enabled: all || enabled.has( name ),
	} ) );
}

/** True when config says "*" -- every plugin, including ones added later. */
export function pluginsAreWildcard() { return !Array.isArray( config.plugins ); }

/** Enabled client-half entry points, as URLs the browser can import. */
export function clientPlugins() {
	return plugins()
		.filter( plugin => plugin.client )
		/*
		 * The URL has to match the layout that was actually found -- a loader
		 * file and a directory index are different paths, and guessing one
		 * would 404 for half the plugins.
		 */
		.map( plugin => clientHalf( plugin.name ).endsWith( `index${CLIENT_EXT}` )
			? `./plugins/${plugin.name}/index${CLIENT_EXT}`
			: `./plugins/${plugin.name}${CLIENT_EXT}` );
}

/** Control modules available for the client to import. */
function controlModules() {
	try {
		return readdirSync( resolve( root, "ui", "controls" ) )
			.filter( name => name.endsWith( ".js" ) )
			.map( name => "./controls/" + name );
	} catch( err ) {
		console.log( "no controls directory:", err.message );
		return [];
	}
}

/**
 * Load plugins, then open the port.
 *
 * Constructing Protocol binds the listener, so it must not happen at module
 * scope: an import that opens the port beats `await loadServerPlugins()` to it,
 * and a client connecting in that window gets empty action and source lists.
 */
export async function start() {
	const loaded = await loadServerPlugins();
	protocol = new Protocol();
	return { protocol, plugins: loaded };
}

/** Null until start() resolves. Live binding, so importers see it appear. */
export let protocol = null;
