/**
 * @fileoverview Designer entry point.
 *
 * Imports the renderer and adds the overlay on top of it.  Served from its own
 * URL so a runtime page never receives any of this -- which is also where
 * authentication belongs, rather than a keystroke that reveals edit mode.
 */

import { CanvasView } from "./render/canvas-view.js";
import { EditOverlay } from "./edit/overlay.js";
import { Control, Page, stringify, parse } from "./core/document.js";
import { controlTree } from "./core/registry.js";
import { glareSetNames } from "./core/glare.js";
import { commonButtonProperties } from "./core/properties.js";
const COMMON_KEYS = commonButtonProperties;
import { createPopupMenu } from "@d3x0r/popups2/menu";
import { createSimpleForm } from "@d3x0r/popups2/forms/simple-form.js";
import { editControlProperties, editStyleProperties, propertyGroups }
	from "./edit/property-panel.js";
import { History } from "./edit/history.js";
import { editPlugins } from "./edit/plugin-editor.js";
import { captureStyle } from "./core/styles.js";
import { editFontPresets, editGlareSets, editPageProperties, editPageOrder }
	from "./edit/resource-editors.js";
import { useProtocol as useImageProtocol, invalidateImages }
	from "./edit/image-picker.js";
import { nameTree } from "./core/registry.js";
import { getControlDef } from "./core/registry.js";
import { toGridUnits, fromGridUnits, GRID } from "./core/coords.js";
import { buildDemoCanvas } from "./demo-canvas.js";
import { protocol } from "./protocol.js";
import * as protocolModule from "./protocol.js";
import { mergeServerActions } from "./core/actions.js";
import { useProtocol } from "./controls/button.js";
import { useProtocol as useTableProtocol } from "./controls/table.js";

// The application: variables, client actions, its own controls.
import "./apps/demo-station.js";

import "./controls/button.js";
import "./controls/label.js";
import "./controls/session.js";
import "./controls/table.js";

/*
 * A document IS an application; the server holds many and the URL picks one.
 * ?doc=Name selects it, which is all "selectable applications" needs to mean --
 * a launcher is then just another document whose table is bound to the
 * 'documents' source and whose button opens the row you picked.
 */
const DOC_NAME = new URLSearchParams( location.search ).get( "doc" )
	|| "Demo Station";
const stage    = document.getElementById( "stage" );

protocol.document = DOC_NAME;
useProtocol( protocolModule );
useTableProtocol( protocolModule );
useImageProtocol( protocolModule );

// Another window uploaded something; drop the cached listing.
protocol.on( "imagesChanged", () => invalidateImages() );

/*
 * Load the same document the runtime loads.  Both sides must agree on control
 * ids, because an id is the only thing a button press sends -- an editor
 * working on a locally invented copy would be assigning ids the server has
 * never seen.
 */
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

/**
 * Show a failure instead of a blank page, and STOP.
 *
 * Deliberately not a fallback to the seed document: if loading a document that
 * exists were to quietly hand back the demo instead, the next Save would write
 * the demo over the user's real work.  A load that fails must not leave an
 * editable canvas on screen at all.
 */
function fatal( message, detail ) {
	document.body.innerHTML = "";
	const box = document.createElement( "div" );
	box.className = "tt-fatal";
	const h = document.createElement( "h2" );
	h.textContent = message;
	const p = document.createElement( "p" );
	p.textContent = detail || "";
	const retry = document.createElement( "button" );
	retry.textContent = "Retry";
	retry.addEventListener( "click", () => location.reload() );
	box.append( h, p, retry );
	document.body.appendChild( box );
	throw new Error( message );
}

async function loadCanvas() {
	if( !await protocol.whenReady() )
		fatal( "No connection to the server",
			"The designer cannot edit a document it could not load."
			+ " Start the service and retry." );

	let reply;
	try {
		reply = await protocol.loadDocument( DOC_NAME, /*editing*/ true );
	} catch( err ) {
		fatal( `Could not load "${DOC_NAME}"`,
			`${err.message}. The document is probably fine -- the server did not`
			+ ` answer. Check that only one instance of the service is running.` );
	}
	if( reply.snapshot ) return parse( reply.snapshot );

	// Genuinely absent: seed it. Distinct from a load that failed.
	const seeded = buildDemoCanvas();
	await protocol.saveDocument( DOC_NAME, stringify( seeded ) );
	return seeded;
}

await loadPlugins();
const canvas  = await loadCanvas();
/*
 * embeds:false -- a page embed runs in the shell's own realm with full DOM
 * access, so executing one inside the designer would let it reach the editor
 * while you are arranging a layout. Design time shows a placeholder instead.
 */
/*
 * security:false -- the designer renders every control regardless of the
 * session's permissions. You cannot arrange a layout around controls you
 * cannot see, and the document it was given is unfiltered anyway.
 */
const view    = new CanvasView( canvas, stage, { embeds: false, security: false } );
const overlay = new EditOverlay( view );

/*
 * Undo lives in the editor, never on the server: a stack shared between windows
 * is what would let one editor undo another's work.  The overlay drives it for
 * gestures; menu operations and dialogs bracket themselves.
 */
const history = new History( view );
overlay.history = history;

// The create menu offers whatever the server exposes as an action.
protocol.listActions()
	.then( ( reply ) => mergeServerActions( reply.actions ) )
	.catch( () => {} );

protocol.listSources()
	.then( ( reply ) => {
		sourceNames = reply.sources.map( s => s.name );
		for( const s of reply.sources ) sourceSchemas[ s.name ] = s.args;
	} )
	.catch( () => {} );

const $ = ( id ) => document.getElementById( id );

/**
 * Ask for a single value.
 *
 * Modal on purpose: it is a blocking question, and as a <dialog> in the top
 * layer it is also immune to the overlay canvas that otherwise sits above
 * everything on the stage.  (Native prompt() was worse than ugly -- some
 * embedded browsers suppress it outright and it silently returns null.)
 */
function askForName( title, question, value, ok, near ) {
	/*
	 * Modal is popups2's default now, so it is not spelled here.  `near` opens
	 * the form beside whatever was just clicked -- these all follow a menu
	 * pick, and appearing where the menu was keeps the two connected rather
	 * than throwing the eye to the middle of the screen.
	 */
	const form = createSimpleForm( title, question, value,
		( v ) => { const name = ( v || "" ).trim(); if( name ) ok( name ); },
		null,
		near ? { near } : undefined );
	form.show();
	return form;
}

// -- context menus -------------------------------------------------------

/*
 * Three menus, following the C editor's split (pControlMenu / pSelectionMenu /
 * pEditMenu):
 *
 *   right-click a control  -> Edit, Edit General, Clone, Destroy
 *   right-click a region   -> Create control (fills the marked rectangle)
 *   right-click background -> page and canvas properties
 *
 * Creating a control belongs to the region menu because marking the space it
 * should occupy is how you say where it goes -- not placing a default-sized
 * control and resizing it afterwards.
 */
const menu = createPopupMenu( { suffix: "tt" } );

function fillCreateMenu( into, node, rect ) {
	for( const [ label, child ] of node.groups )
		fillCreateMenu( into.addMenu( label ), child, rect );
	for( const item of node.items )
		into.addItem( item.label, () => placeControl( item.name, rect ) );
}

function placeControl( type, rect ) {
	const control = new Control( type, rect.x, rect.y, rect.w, rect.h );
	history.transact( `Create ${type}`, () => {
		// Touched before it joins a page, so `before` records "did not exist".
		history.touch( control );
		view.addControl( control, overlay.target );
	} );
	overlay.clearRegion();
	overlay.select( control, false );
}

/** A default rectangle for when nothing was marked. */
function defaultRect( gx, gy ) {
	const cw = GRID / canvas.grid.divisorX;
	const ch = GRID / canvas.grid.divisorY;
	return { x: Math.round( gx ), y: Math.round( gy ),
	         w: Math.round( cw * 4 ), h: Math.round( ch * 2 ) };
}

overlay.on( "contextmenu", ( e ) => {
	menu.reset();

	if( e.control ) buildControlMenu( menu, e.control, { x: e.x, y: e.y } );
	else if( e.region ) buildRegionMenu( menu, e.region );
	else buildPageMenu( menu, e );

	menu.show( e.x, e.y );
} );

/** Repaint everything on the page and the shared layer. */
function repaintAll() {
	for( const page of [ view.page, canvas.shared ] )
		if( page ) for( const control of page.controls ) view.refresh( control );
	overlay.invalidate();
}

/** Repaint every control a preset governs. */
function refreshStyleUsers( controls ) {
	for( const c of controls ) view.refresh( c );
	overlay.invalidate();
}

function fillStyleMenu( into, node, onPick ) {
	for( const [ label, child ] of node.groups )
		fillStyleMenu( into.addMenu( label ), child, onPick );
	for( const item of node.items )
		into.addItem( item.label, () => onPick( item.name ) );
}

function buildControlMenu( into, control, at ) {
	// Only offer a half the control actually has.
	const groups = propertyGroups( getControlDef( control.type ) );
	if( groups.hasSpecific )
		into.addItem( "Edit", () => editControl( control, false, at ) );
	if( groups.hasGeneral )
		into.addItem( "Edit General", () => editControl( control, true, at ) );
	into.addItem( "Clone", () => {
		const cw = GRID / canvas.grid.divisorX;
		const copy = new Control( control.type,
			control.x + Math.round( cw ), control.y + Math.round( cw ),
			control.w, control.h,
			JSON.parse( JSON.stringify( control.props ) ) );
		history.transact( "Clone", () => {
			history.touch( copy );
			view.addControl( copy, control.page );
		} );
		overlay.select( copy, false );
	} );
	into.separate();

	/*
	 * Capture the control's GENERAL values as a preset -- the appearance half.
	 * Capturing everything would drag text and action in, and a preset that
	 * governs those overwrites what makes each button distinct.
	 */
	into.addItem( "Capture style...", () => {
		const def = getControlDef( control.type );
		const keys = Object.keys( propertyGroups( def ).hasGeneral
			? splitGeneralKeys( def ) : {} );
		askForName( "Capture style", "Name for the new style preset",
			suggestStyleName(), ( name ) => {
				canvas.styles[ name ] = captureStyle( control.props, keys );
				// The control it came from should follow it, not keep a private copy.
				for( const k of keys ) control.revert( k );
				control.preset = name;
				view.refresh( control );
				showSelection( overlay.selection );
			} );
	} );

	const styleNames = canvas.styleNames();
	if( styleNames.length ) {
		const use = into.addMenu( "Use style" );
		use.addItem( "(none)", () => {
			control.preset = null; view.refresh( control ); } );
		fillStyleMenu( use, nameTree( styleNames ), ( name ) => {
			control.preset = name;
			view.refresh( control );
			showSelection( overlay.selection );
		} );
	}

	into.separate();
	into.addItem( "Destroy", () => {
		const doomed = overlay.selection;
		history.transact( doomed.length > 1 ? `Delete ${doomed.length} controls` : "Delete",
			() => {
				for( const c of doomed ) { history.touch( c ); view.removeControl( c ); }
			} );
		overlay.clearSelection();
	} );
}

function buildRegionMenu( into, rect ) {
	fillCreateMenu( into.addMenu( "Create control" ), controlTree(), rect );
	into.separate();
	into.addItem( "Clear region", () => overlay.clearRegion() );
}

function buildPageMenu( into, e ) {
	fillCreateMenu( into.addMenu( "Create control" ), controlTree(),
	                defaultRect( e.gx, e.gy ) );
	into.separate();

	into.addItem( "Page properties...", () => {
		editPageProperties( view.page, {
			near: { x: e.x, y: e.y },
			history,
			// The page element carries the background, so re-show it.
			onChange: () => view.showBackground(),
		} );
	} );

	/*
	 * Both edit document data, so a change has to repaint everything -- a font
	 * preset or glare set is referenced by name from any number of controls.
	 */
	into.addItem( "Edit fonts...", () => {
		editFontPresets( canvas, { near: { x: e.x, y: e.y }, onChange: repaintAll, history } );
	} );
	into.addItem( "Edit button glares...", () => {
		editGlareSets( canvas, { near: { x: e.x, y: e.y }, onChange: repaintAll, history } );
	} );

	const allStyles = canvas.styleNames();
	if( allStyles.length ) {
		const edit = into.addMenu( "Edit style" );
		fillStyleMenu( edit, nameTree( allStyles ), ( name ) => {
			editStyleProperties( canvas, name,
				{ onChange: refreshStyleUsers, near: { x: e.x, y: e.y }, history } );
		} );
	}
	into.separate();

	into.addItem( "Create page", () => {
		// "Page N" for N pages, then uniquified in case that name is taken.
		const suggested = canvas.uniquePageTitle( `Page ${canvas.pages.length + 1}` );
		askForName( "Create page", "Name for the new page", suggested, ( name ) => {
			const page = new Page( canvas.uniquePageTitle( name ) );
			history.transact( "Create page", () => {
				history.touchPage( page );      // not in canvas.pages yet
				canvas.addPage( page );
			} );
			refreshPages();
			view.showPage( page );
		}, { x: e.x, y: e.y } );
	} );
	into.addItem( "Rename page", () => {
		const page = view.page;
		askForName( "Rename page", "New name for this page", page.title, ( name ) => {
			history.transact( "Rename page", () => {
				history.touchPage( page );
				page.title = canvas.uniquePageTitle( name, page );
			} );
			refreshPages();
		}, { x: e.x, y: e.y } );
	} );

	const live = canvas.livePages();
	if( live.length > 1 ) {
		const change = into.addMenu( "Change page" );
		for( const page of live )
			if( page !== view.page )
				change.addItem( page.title, () => view.showPage( page ) );

		const destroy = into.addMenu( "Destroy page" );
		for( const page of live )
			destroy.addItem( page.title, () => {
				history.transact( "Destroy page", () => {
					history.touchPage( page );
					page.deleted = true;
				} );
				if( page === view.page ) view.showPage( canvas.livePages()[ 0 ] );
				refreshPages();
			} );
	}

	const gone = canvas.deletedPages();
	if( gone.length ) {
		const undo = into.addMenu( "Undestroy page" );
		for( const page of gone )
			undo.addItem( page.title, () => {
				history.transact( "Undestroy page", () => {
					history.touchPage( page );
					page.deleted = false;
				} );
				refreshPages();
			} );
	}

	into.separate();
	const layers = into.addMenu( "Layer" );
	layers.addItem( "Page", () => setLayer( "page" ) );
	layers.addItem( "Shared (header/footer)", () => setLayer( "shared" ) );
}

/** Which keys a capture should take: the appearance half. */
function splitGeneralKeys( def ) {
	const out = {};
	for( const [ key, spec ] of Object.entries( ( def && def.properties ) || {} ) ) {
		const group = spec.group || ( key in COMMON_KEYS ? "general" : "specific" );
		// A preset governs look, never identity or behaviour.
		if( group === "general" && key !== "text" && key !== "nextPage"
		    && key !== "security" ) out[ key ] = spec;
	}
	return out;
}

function suggestStyleName() {
	const n = canvas.styleNames().length + 1;
	return canvas.styleNames().includes( `Style ${n}` ) ? `Style ${n + 1}` : `Style ${n}`;
}

/** Source names and arg schemas, so the panel can offer them. */
let sourceNames = [];
let sourceSchemas = {};

function editControl( control, generalOnly, near ) {
	editControlProperties( control, {
		generalOnly,
		near,
		canvas,
		/*
		 * One undo entry for the whole dialog session, committed on Okay.
		 * Edits still apply live -- what the transaction changes is the
		 * granularity, not the moment of application.  Cancel aborts, so a
		 * cancelled dialog leaves no trace in the stack.
		 */
		history,
		sources: sourceNames,
		sourceSchemas,
		// Live: the point of a designer is seeing the change as you make it.
		onChange() {
			view.refresh( control );
			view.place( control );
			overlay.invalidate();
			showSelection( overlay.selection );
		},
	} );
}

// -- page list -----------------------------------------------------------

function refreshPages() {
	const sel = $( "pages" );
	sel.textContent = "";
	for( const page of canvas.livePages() ) {
		const opt = document.createElement( "option" );
		opt.value = opt.textContent = page.title;
		if( page === view.page ) opt.selected = true;
		sel.appendChild( opt );
	}
}

$( "pages" ).addEventListener( "change", ( e ) => view.showPage( e.target.value ) );

function setLayer( which ) {
	overlay.layer = which;
	$( "layer" ).value = which;
	$( "pages" ).disabled = which === "shared";
	showSelection( [] );
}

for( const [ id, key ] of [ [ "divx", "divisorX" ], [ "divy", "divisorY" ] ] )
	$( id ).addEventListener( "change", ( e ) => {
		// Changing the ruler must not move anything -- storage is fine units.
		canvas.grid[ key ] = Math.max( 1, Number( e.target.value ) || 1 );
		overlay.invalidate();
		showSelection( overlay.selection );
	} );

$( "snap" ).addEventListener( "change", ( e ) => {
	overlay.snapEnabled = e.target.checked;
} );

// -- layers and bands ----------------------------------------------------

$( "layer" ).addEventListener( "change", ( e ) => setLayer( e.target.value ) );

/* Shell insets, entered in grid cells, on all four sides. */
const INSETS = [
	[ "header", "top",    "divisorY", false ],
	[ "footer", "bottom", "divisorY", true  ],
	[ "railL",  "left",   "divisorX", false ],
	[ "railR",  "right",  "divisorX", true  ],
];

function applyBands() {
	history.transact( "Shell insets", () => {
		history.touchCanvas( canvas, "body" );
		for( const [ id, side, div, fromFar ] of INSETS ) {
			const fine = fromGridUnits( Number( $( id ).value ) || 0, canvas.grid[ div ] );
			canvas.body[ side ] = fromFar ? GRID - fine : fine;
		}
	} );
	overlay.invalidate();
}

function showBands() {
	for( const [ id, side, div, fromFar ] of INSETS ) {
		const fine = fromFar ? GRID - canvas.body[ side ] : canvas.body[ side ];
		$( id ).value = +toGridUnits( fine, canvas.grid[ div ] ).toFixed( 2 );
	}
}

for( const [ id ] of INSETS ) $( id ).addEventListener( "change", applyBands );

// -- selection readout, in grid units ------------------------------------

function showSelection( selection ) {
	if( !selection.length ) { $( "status" ).textContent = "no selection"; return; }
	if( selection.length > 1 ) {
		$( "status" ).textContent = `${selection.length} controls`;
		return;
	}
	const c = selection[ 0 ];
	const where = c.page === canvas.shared ? "shared" : c.page.title;
	const { divisorX: dx, divisorY: dy } = canvas.grid;
	const f = ( v, d ) => toGridUnits( v, d ).toFixed( 2 ).replace( /\.00$/, "" );
	$( "status" ).textContent =
		`${c.type} [${where}]  @ ${f( c.x, dx )},${f( c.y, dy )}  `
		+ `${f( c.w, dx )}x${f( c.h, dy )} cells   (${c.x},${c.y} ${c.w}x${c.h} fine)`;
}

overlay.on( "selection", showSelection );
overlay.on( "changed", () => showSelection( overlay.selection ) );
overlay.on( "removed", () => showSelection( [] ) );
overlay.on( "edit", ( control ) => editControl( control ) );

view.on( "pageShown", () => { refreshPages(); showSelection( [] ); } );

// -- persistence ---------------------------------------------------------

$( "save" ).addEventListener( "click", async () => {
	// Destroyed pages go for good here; undestroy only reaches back this far.
	const dropped = canvas.compact();
	if( dropped.length ) refreshPages();
	$( "status" ).textContent = dropped.length
		? `saving (dropping ${dropped.length} destroyed page${dropped.length > 1 ? "s" : ""})...`
		: "saving...";
	const reply = await protocol.saveDocument( DOC_NAME, stringify( canvas ) );
	$( "status" ).textContent = `saved '${reply.name}'`;
} );

$( "load" ).addEventListener( "click", async () => {
	const reply = await protocol.loadDocument( DOC_NAME );
	if( !reply.snapshot ) { $( "status" ).textContent = "no stored document"; return; }
	const loaded = parse( reply.snapshot );
	canvas.pages.length = 0;
	for( const page of loaded.pages ) canvas.addPage( page );
	canvas.grid = loaded.grid;
	canvas.shared = loaded.shared;
	canvas.body = loaded.body;
	$( "divx" ).value = canvas.grid.divisorX;
	$( "divy" ).value = canvas.grid.divisorY;
	showBands();
	overlay.clearSelection();
	view.showPage( canvas.pages[ 0 ] );
	view.buildShared();
	$( "status" ).textContent = `loaded ${canvas.pages.length} pages`;
} );

// -- undo ----------------------------------------------------------------

$( "undo" ).addEventListener( "click", () => history.undo() );
$( "redo" ).addEventListener( "click", () => history.redo() );

history.onChange( ( info ) => {
	const undoBtn = $( "undo" ), redoBtn = $( "redo" );
	undoBtn.disabled = !history.canUndo;
	redoBtn.disabled = !history.canRedo;
	undoBtn.title = history.canUndo ? `Undo ${history.undoLabel} (Ctrl+Z)` : "Undo (Ctrl+Z)";
	redoBtn.title = history.canRedo ? `Redo ${history.redoLabel} (Ctrl+Y)` : "Redo (Ctrl+Y)";

	if( info.entry ) {
		// Geometry may have moved under it, and the panel shows grid units.
		showSelection( overlay.selection );
		overlay.invalidate();
		refreshPages();
		showBands();          // an undone inset change must show in the toolbar
		/*
		 * Records whose entity was changed by someone else since are skipped
		 * rather than re-applied, so say so -- silently doing less than asked
		 * is worse than doing nothing.
		 */
		if( info.stale )
			console.warn( `${info.stale} of ${info.entry.records.length} changes were`
				+ ` skipped: they had been changed since` );
	}
} );

/*
 * Which plugins load is a property of the DEPLOYMENT, not of a document, so
 * this is a service setting rather than anything that serializes with a canvas.
 */
/*
 * Page order is the attract loop's order and what (next) steps through, so it
 * gets a place of its own rather than being inferred from a dropdown.
 */
$( "pages-order" ).addEventListener( "click", ( e ) => {
	editPageOrder( canvas, {
		near: { x: e.clientX, y: e.clientY + 8 },
		history,
		currentPage: () => view.page,
		showPage: ( page ) => view.showPage( page ),
		onChange: () => { refreshPages(); overlay.invalidate(); },
	} );
} );

$( "plugins" ).addEventListener( "click", ( e ) => {
	editPlugins( protocol, { near: { x: e.clientX, y: e.clientY + 8 } } );
} );

$( "dump" ).addEventListener( "click", () => {
	const wire = $( "wire" );
	wire.hidden = !wire.hidden;
	if( !wire.hidden ) wire.textContent = stringify( canvas );
} );

// The editor never navigates on a control click; the overlay eats the pointer.
stage.addEventListener( "tt-session", ( e ) => e.stopPropagation(), true );

view.showPage( canvas.pages[ 0 ] );
view.buildShared();
overlay.enable( true );
refreshPages();
showBands();

export { view, overlay, canvas };
