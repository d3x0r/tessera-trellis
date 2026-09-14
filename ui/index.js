/**
 * @fileoverview Runtime entry point.
 *
 * This URL renders a document and nothing else -- no overlay, no editing
 * machinery, none of it even loaded.  The editor is a separate page that
 * imports this same renderer.
 *
 * The document comes FROM THE SERVER, and that is not incidental.  A button
 * press is sent as "control <id> was pressed" and the server resolves that id
 * against its own copy.  A locally invented document would carry ids the
 * server has never heard of -- the same property, seen from the other side,
 * that stops a client naming actions it was never given.
 */

import { CanvasView } from "./render/canvas-view.js";
import { parse, stringify } from "./core/document.js";
import { buildDemoCanvas } from "./demo-canvas.js";
import { mergeServerActions } from "./core/actions.js";
import { setVariable } from "./core/variables.js";
import { watchIdle } from "./core/idle.js";
import { useProtocol } from "./controls/button.js";
import { useProtocol as useTableProtocol } from "./controls/table.js";
import * as protocolModule from "./protocol.js";

// Control modules register as an import side effect -- the PRELOAD equivalent.
// The application: variables, client actions, its own controls.
import "./apps/demo-station.js";

import "./controls/button.js";
import "./controls/label.js";
import "./controls/session.js";
import "./controls/table.js";
import "./controls/field.js";

/*
 * A document IS an application; the server holds many and the URL picks one.
 * ?doc=Name selects it, which is all "selectable applications" needs to mean --
 * a launcher is then just another document whose table is bound to the
 * 'documents' source and whose button opens the row you picked.
 */
const DOC_NAME = new URLSearchParams( location.search ).get( "doc" )
	|| "Demo Station";
const stage = document.getElementById( "stage" );
const protocol = protocolModule.protocol;

// Controls talk to the server through this; without it, client actions still run.
useProtocol( protocolModule );
useTableProtocol( protocolModule );
protocol.document = DOC_NAME;

/**
 * Import every client-half plugin the server offers.
 *
 * This must finish BEFORE the document renders: a document may contain a
 * control type that only a plugin registers, and an unregistered type renders
 * as nothing.  A plugin gets the protocol the same way built-in controls do.
 */
async function loadPlugins() {
	// The socket must be open first: a request sent before it opens is dropped
	// silently, and this is awaited at module top level.
	if( !await protocol.whenReady() ) return [];

	let list = [];
	try { list = ( await protocol.listPlugins() ).plugins || []; }
	catch( err ) { console.warn( "plugin list unavailable:", err.message ); return []; }

	for( const path of list ) {
		try {
			const mod = await import( path );
			if( mod.useProtocol ) mod.useProtocol( protocolModule );
		} catch( err ) {
			console.warn( `plugin ${path} failed:`, err.message );
		}
	}
	return list;
}

async function loadCanvas() {
	if( !await protocol.whenReady() ) {
		console.warn( "no server; running the built-in document" );
		return buildDemoCanvas();
	}
	const reply = await protocol.loadDocument( DOC_NAME );
	if( reply.snapshot ) return parse( reply.snapshot );

	// First run: seed the store, so both sides agree on control ids.
	const seeded = buildDemoCanvas();
	await protocol.saveDocument( DOC_NAME, stringify( seeded ) );
	return seeded;
}

// A ticket on the URL is redeemed BEFORE the document is fetched, because the
// fetch is what filters on the session; afterwards would show the anonymous view.
await protocol.redeemTicketFromUrl();
await loadPlugins();
const canvas = await loadCanvas();
const view = new CanvasView( canvas, stage );

/**
 * The Session control announces intent; the application decides.  What 'Quit'
 * means is a deployment question, not a control question.
 */
stage.addEventListener( "tt-session", ( e ) => {
	switch( e.detail.mode ) {
	case "home":   view.showPage( canvas.pages[ 0 ] ); break;
	case "reload": location.reload(); break;
	case "close":  window.close(); break;
	case "logout":
	default:       location.href = "/logout"; break;
	}
} );

/*
 * A server action that changes shared state broadcasts, so every window
 * updates -- not just the one whose button was pressed.
 */
protocol.on( "hallState", ( msg ) => {
	setVariable( "Hall", `${msg.hall}: ${msg.enabled ? "enabled" : "disabled"}` );
} );

// The designer offers whatever the server exposes; the runtime needs the list
// only to know which actions are server-side.
protocol.listActions()
	.then( ( reply ) => mergeServerActions( reply.actions ) )
	.catch( () => { /* offline: client actions still work */ } );

view.showPage( canvas.pages[ 0 ] );
view.buildShared();

/*
 * Screen saver.
 *
 * Runtime only -- the designer must never blank itself while you are arranging
 * a layout, which is why this lives here and not in the shared renderer.
 *
 * Activity comes from input on this page plus tt-activity relayed by any Web
 * Page control whose framed client reports it; a cross-origin frame leaks
 * nothing on its own, so without that relay a station showing only an embedded
 * application would blank while someone was using it.
 */
let returnTo = null;
let rotateTimer = null;

/**
 * Step through the screen-saver pages.
 *
 * Each page holds for its own screensaverSeconds; 0 means hold it until
 * activity, which is also what a single page does. Recomputed on every step
 * rather than captured once, so editing the set in another window takes effect
 * on the next turn instead of at the next idle.
 */
function rotate( index ) {
	const pages = canvas.screensaverPages();
	if( !pages.length ) return;
	const page = pages[ index % pages.length ];
	view.showPage( page );

	const seconds = Number( page.screensaverSeconds ) || 0;
	// Nowhere to advance to, or told to hold: stop here.
	if( pages.length < 2 || seconds <= 0 ) return;
	rotateTimer = setTimeout( () => rotate( index + 1 ), seconds * 1000 );
}

function stopRotating() {
	if( rotateTimer ) { clearTimeout( rotateTimer ); rotateTimer = null; }
}

const idle = watchIdle( {
	minutes: ( canvas.idle && canvas.idle.minutes ) || 0,
	onIdle() {
		const pages = canvas.screensaverPages();
		if( !pages.length || pages.includes( view.page ) ) return;
		returnTo = view.page;
		rotate( 0 );
	},
	onWake() {
		stopRotating();
		if( !returnTo ) return;
		const back = returnTo;
		returnTo = null;
		// It may have been destroyed while we were blanked.
		if( canvas.livePages().includes( back ) ) view.showPage( back );
	},
} );

if( canvas.screensaverPages().length && !( canvas.idle && canvas.idle.minutes > 0 ) )
	console.log( "screensaver pages are set but the idle timeout is 0;"
		+ " they will only appear on an explicit tt-screensaver request" );

export { idle };

export { view, canvas, protocol };
