/**
 * Headless exercise of ui/edit/history.js against the real document model,
 * with a stub view that does the model half of what CanvasView does.
 */

import { Canvas, Page, Control } from "./ui/core/document.js";
import { registerControl } from "./ui/core/registry.js";
import { History } from "./ui/edit/history.js";
import { Style } from "./ui/core/styles.js";

registerControl( "Button", {
	properties: { text: { type: "string", default: "" },
	              color: { type: "color", default: "#000" } },
	create() {},
} );

class StubView {
	constructor( canvas ) { this.canvas = canvas; this.page = null; }
	showPage( p ) { this.page = p; return p; }
	showBackground() {}
	place() {} refresh() {}
	addControl( c, page, index ) {
		const target = page || this.page;
		if( c.page !== target ) target.add( c );
		if( index !== undefined ) this.reindex( c, index );
		return c;
	}
	removeControl( c ) { c.page.remove( c ); }
	reindex( c, index ) {
		const page = c.page; if( !page ) return;
		const at = page.controls.indexOf( c ); if( at < 0 ) return;
		const to = Math.max( 0, Math.min( index, page.controls.length - 1 ) );
		if( at === to ) return;
		page.controls.splice( at, 1 );
		page.controls.splice( to, 0, c );
	}
}

let pass = 0, fail = 0;
function check( name, cond, extra ) {
	if( cond ) { pass++; console.log( "  ok   " + name ); }
	else { fail++; console.log( "  FAIL " + name, extra === undefined ? "" : extra ); }
}

function fresh() {
	const canvas = new Canvas( "T" );
	const page = canvas.addPage( new Page( "Main" ) );
	const view = new StubView( canvas );
	view.showPage( page );
	const history = new History( view );
	return { canvas, page, view, history };
}

// -- 1. move: undo and redo ----------------------------------------------
{
	const { page, history } = fresh();
	const c = new Control( "Button", 100, 100, 500, 500 );
	page.add( c );

	history.begin( "Move" );
	history.touch( c );
	c.x = 900; c.y = 800;
	history.commit();

	check( "move recorded", history.depth === 1 && history.canUndo );
	history.undo();
	check( "undo restores position", c.x === 100 && c.y === 100, [ c.x, c.y ] );
	check( "undo clears canUndo", !history.canUndo && history.canRedo );
	history.redo();
	check( "redo reapplies", c.x === 900 && c.y === 800, [ c.x, c.y ] );
}

// -- 2. an unchanged transaction records nothing --------------------------
{
	const { page, history } = fresh();
	const c = new Control( "Button", 100, 100, 500, 500 );
	page.add( c );
	history.begin( "Move" ); history.touch( c ); history.commit();
	check( "no-op commit pushes nothing", history.depth === 0 );
}

// -- 3. nudges coalesce, and a selection change ends the run --------------
{
	const { page, history } = fresh();
	const c = new Control( "Button", 100, 100, 500, 500 );
	page.add( c );
	for( let i = 0; i < 8; i++ ) {
		history.begin( "Nudge", "nudge:" + c.id );
		history.touch( c );
		c.x += 10;
		history.commit();
	}
	check( "8 nudges are 1 entry", history.depth === 1, history.depth );
	check( "nudges applied", c.x === 180, c.x );
	history.undo();
	check( "one undo reverses the whole run", c.x === 100, c.x );

	history.redo();
	history.begin( "Nudge", "nudge:other" );
	history.touch( c ); c.x += 10; history.commit();
	check( "a different run starts a new entry", history.depth === 2, history.depth );
}

// -- 4. delete restores z-order, not just existence ----------------------
{
	const { page, view, history } = fresh();
	const a = page.add( new Control( "Button", 0, 0, 100, 100 ) );
	const b = page.add( new Control( "Button", 0, 0, 100, 100 ) );
	const d = page.add( new Control( "Button", 0, 0, 100, 100 ) );
	check( "middle control is at index 1", page.controls.indexOf( b ) === 1 );

	history.begin( "Delete" ); history.touch( b ); view.removeControl( b ); history.commit();
	check( "deleted", page.controls.length === 2 && !b.page );

	history.undo();
	check( "undo restores it", page.controls.length === 3 && b.page === page );
	check( "undo restores z-order", page.controls.indexOf( b ) === 1,
		page.controls.indexOf( b ) );
	check( "neighbours undisturbed",
		page.controls[ 0 ] === a && page.controls[ 2 ] === d );
}

// -- 5. create -----------------------------------------------------------
{
	const { page, view, history } = fresh();
	const c = new Control( "Button", 0, 0, 100, 100 );
	history.begin( "Create" ); history.touch( c ); view.addControl( c, page ); history.commit();
	check( "created", page.controls.length === 1 );
	history.undo();
	check( "undo removes the created control", page.controls.length === 0 && !c.page );
	history.redo();
	check( "redo re-creates it", page.controls.length === 1 && c.page === page );
}

// -- 6. dialog: capture + record, and a cancelled dialog leaves no trace --
{
	const { page, history } = fresh();
	const c = page.add( new Control( "Button", 0, 0, 100, 100, { text: "before" } ) );

	const snap = history.capture( c );
	c.props.text = "after";
	c.props.color = "#ff0000";
	history.record( "Edit Button", [ { target: c, before: snap } ] );
	check( "dialog is one entry", history.depth === 1 );
	history.undo();
	check( "undo restores all dialog keys",
		c.props.text === "before" && c.props.color === "#000",
		[ c.props.text, c.props.color ] );

	// A cancelled dialog: restore first, then record -- before == after.
	const before = history.depth;
	const snap2 = history.capture( c );
	c.props.text = "typing";
	c.props.text = "before";                     // cancel restored it
	history.record( "Edit Button", [ { target: c, before: snap2 } ] );
	check( "cancelled dialog records nothing", history.depth === before, history.depth );
}

// -- 7. a record overtaken by someone else is skipped, not re-applied -----
{
	const { page, history } = fresh();
	const c = page.add( new Control( "Button", 100, 100, 500, 500 ) );
	history.begin( "Move" ); history.touch( c ); c.x = 900; history.commit();

	c.x = 4321;                                  // as if another editor moved it
	const result = history.undo();
	check( "stale record is skipped", result.stale === 1 && result.applied === 0, result );
	check( "the newer value survives", c.x === 4321, c.x );
}

// -- 8. a new operation truncates the redo branch ------------------------
{
	const { page, history } = fresh();
	const c = page.add( new Control( "Button", 0, 0, 100, 100 ) );
	history.begin( "A" ); history.touch( c ); c.x = 10; history.commit();
	history.begin( "B" ); history.touch( c ); c.x = 20; history.commit();
	history.undo();
	check( "redo available mid-stack", history.canRedo );
	history.begin( "C" ); history.touch( c ); c.x = 99; history.commit();
	check( "new op discards the redo branch", !history.canRedo && history.depth === 2,
		[ history.depth, history.canRedo ] );
}

// -- 9. undo must not record itself --------------------------------------
{
	const { page, history } = fresh();
	const c = page.add( new Control( "Button", 0, 0, 100, 100 ) );
	history.begin( "Move" ); history.touch( c ); c.x = 500; history.commit();
	history.undo();
	check( "undo did not push an entry", history.depth === 1, history.depth );
}

// -- 10. page rename / destroy / undestroy -------------------------------
{
	const { canvas, history } = fresh();
	const p = canvas.pages[ 0 ];
	history.begin( "Rename page" ); history.touchPage( p ); p.title = "Renamed"; history.commit();
	history.undo();
	check( "undo restores page title", p.title === "Main", p.title );

	history.begin( "Destroy page" ); history.touchPage( p ); p.deleted = true; history.commit();
	check( "page destroyed", canvas.livePages().length === 0 );
	history.undo();
	check( "undo undestroys the page", canvas.livePages().length === 1 );
}

// -- 11. canvas keys: undo must not strip class identity -----------------
{
	const { canvas, history } = fresh();
	canvas.styles = { Danger: new Style( [ "color" ], { color: "#f00" } ) };

	const before = history.captureCanvas( canvas, "styles" );
	canvas.styles.Danger.set( "textColor", "#fff" );
	history.record( "Edit style", [ { kind: "canvas", target: canvas, key: "styles", before } ] );
	check( "style edit recorded", history.depth === 1 );

	history.undo();
	const restored = canvas.styles.Danger;
	check( "undo restores the governed key set",
		JSON.stringify( restored.keys ) === JSON.stringify( [ "color" ] ), restored.keys );
	/*
	 * The trap: structuredClone strips prototypes, so a naive clone would give
	 * back a plain object here and the next repaint would die on .governs().
	 */
	check( "undo keeps Style class identity", restored instanceof Style,
		restored && restored.constructor && restored.constructor.name );
	check( "restored Style methods work",
		typeof restored.governs === "function" && restored.governs( "color" ) === true );

	history.redo();
	check( "redo reapplies and keeps identity",
		canvas.styles.Danger instanceof Style
		&& canvas.styles.Danger.governs( "textColor" ) === true );
}

// -- 12. plain canvas keys (fonts) round-trip too ------------------------
{
	const { canvas, history } = fresh();
	canvas.fonts = { "Label Font": { font: "400 2.4vh sans-serif" } };
	const before = history.captureCanvas( canvas, "fonts" );
	canvas.fonts[ "Title Font" ] = { font: "600 3vh sans-serif" };
	history.record( "Edit fonts", [ { kind: "canvas", target: canvas, key: "fonts", before } ] );
	history.undo();
	check( "undo drops the added font", !canvas.fonts[ "Title Font" ]
		&& !!canvas.fonts[ "Label Font" ], Object.keys( canvas.fonts ) );
}

// -- 13. an unchanged dialog session records nothing ---------------------
{
	const { canvas, history } = fresh();
	canvas.fonts = { A: { font: "x" } };
	const before = history.captureCanvas( canvas, "fonts" );
	history.record( "Edit fonts", [ { kind: "canvas", target: canvas, key: "fonts", before } ] );
	check( "opening and closing without editing records nothing", history.depth === 0 );
}


console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
