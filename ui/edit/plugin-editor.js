/**
 * @fileoverview Plugin panel — which plugins this service loads.
 *
 * Editor-only, and deliberately not part of a document: which plugins run is a
 * property of the deployment, not of the layout.  Two documents on one server
 * see the same set, and a document is portable to a server that has a different
 * one (a control type nothing registers simply renders as nothing).
 *
 * It writes `plugins` in config.jsox, which takes effect on **restart**.  That
 * is not laziness: a server half is imported once at startup and an ES module
 * cannot be un-imported, so a panel that claimed to apply immediately would be
 * lying about the half that matters.  The panel says so instead.
 */

import { popups } from "@d3x0r/popups2";
import { createSimpleNotice } from "@d3x0r/popups2/forms/simple-notice.js";

let open = null;

/** Informational, single Okay. */
function tell( title, message ) {
	const notice = createSimpleNotice( title, message, () => {}, undefined,
		{ modal: true } );
	notice.show();
	return notice;
}

/**
 * @param {object} protocol  the client protocol module's protocol instance
 * @param {{near?:{x:number,y:number}}} [opts]
 */
export async function editPlugins( protocol, opts = {} ) {
	if( open ) {
		if( typeof open.raise === "function" ) open.raise();
		return open;
	}

	let reply;
	try {
		reply = await protocol.listAllPlugins();
	} catch( err ) {
		tell( "Plugins", `Could not read the plugin list: ${err.message}` );
		return null;
	}

	const plugins = reply.plugins || [];
	const popup = popups.create( "Plugins" );
	open = popup;

	/*
	 * Forget the panel on EVERY way out, not just the "close" event: hide()
	 * does not reliably raise it, and a stale reference here would make the
	 * toolbar button look dead -- it would raise() a hidden popup instead of
	 * building a new one.  (Same trap the property panel hit.)
	 *
	 * remove() as well as hide(), because hide() only sets display:none and
	 * this panel is rebuilt from a fresh server fetch every time -- so without
	 * it, every open leaves another dead frame in the document.
	 */
	const close = () => { open = null; popup.hide(); popup.remove(); };
	popup.on( "close", () => { open = null; popup.remove(); } );

	const body = document.createElement( "div" );
	body.className = "tt-prop-form tt-plugins";
	popup.divContent.appendChild( body );

	if( !plugins.length ) {
		const empty = document.createElement( "p" );
		empty.className = "tt-args-empty";
		empty.textContent = "No plugins found in server/plugins or ui/plugins.";
		body.appendChild( empty );
	}

	/** @type {Map<string,HTMLInputElement>} */
	const boxes = new Map();

	for( const plugin of plugins ) {
		const row = document.createElement( "label" );
		row.className = "tt-plugin-row";

		const box = document.createElement( "input" );
		box.type = "checkbox";
		box.checked = !!plugin.enabled;
		boxes.set( plugin.name, box );

		const name = document.createElement( "span" );
		name.className = "tt-plugin-name";
		name.textContent = plugin.name;

		/*
		 * Show which halves exist.  A one-sided plugin is legal -- server-only
		 * is an action provider with no UI, client-only is controls needing no
		 * server -- and seeing which is which explains why enabling one changes
		 * the create menu and another does not.
		 */
		const halves = document.createElement( "span" );
		halves.className = "tt-plugin-halves";
		const parts = [];
		if( plugin.server ) parts.push( "server" );
		if( plugin.client ) parts.push( "client" );
		halves.textContent = parts.join( " + " ) || "no halves";
		if( !parts.length ) halves.classList.add( "tt-plugin-broken" );

		row.append( box, name, halves );
		body.appendChild( row );
	}

	const note = document.createElement( "p" );
	note.className = "tt-plugin-note";
	note.textContent = "Changes are written to config.jsox and take effect when"
		+ " the service restarts — a server-half module cannot be unloaded"
		+ " from a running process.";
	body.appendChild( note );

	if( reply.configFile ) {
		const where = document.createElement( "p" );
		where.className = "tt-plugin-path";
		where.textContent = reply.configFile;
		body.appendChild( where );
	}

	const buttons = document.createElement( "div" );
	buttons.className = "tt-prop-buttons";

	const save = document.createElement( "button" );
	save.textContent = "Save";
	save.addEventListener( "click", async () => {
		const names = [ ...boxes.entries() ]
			.filter( ( [ , box ] ) => box.checked )
			.map( ( [ name ] ) => name );
		save.disabled = true;
		try {
			const result = await protocol.setPlugins( names );
			close();
			if( result.ok )
				tell( "Plugins saved",
					( names.length ? `Enabled: ${names.join( ", " )}.` : "All plugins disabled." )
					+ ( result.restartRequired
						? " Restart the service for this to take effect."
						: " Reload the page for this to take effect." ) );
			else
				tell( "Plugins", `Could not write ${result.file}: ${result.error}` );
		} catch( err ) {
			save.disabled = false;
			tell( "Plugins", `Save failed: ${err.message}` );
		}
	} );

	const cancel = document.createElement( "button" );
	cancel.textContent = "Cancel";
	cancel.addEventListener( "click", close );

	buttons.append( save, cancel );
	popup.divContent.appendChild( buttons );

	popup.show();

	const near = opts.near;
	if( near ) {
		const frame = popup.divFrame;
		const w = frame.offsetWidth || 360, h = frame.offsetHeight || 280;
		frame.style.left = Math.max( 8, Math.min( near.x, window.innerWidth - w - 8 ) ) + "px";
		frame.style.top  = Math.max( 8, Math.min( near.y, window.innerHeight - h - 8 ) ) + "px";
	}
	return popup;
}
