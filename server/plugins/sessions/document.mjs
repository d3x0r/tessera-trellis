/**
 * @fileoverview The "Session Manager" document.
 *
 * Document construction only, in the manner of ui/demo-canvas.js: the seed
 * is written to the store once, when no document of that name exists, and
 * from then on the designer owns it.  Re-running never overwrites -- a hall
 * that has moved buttons around keeps them.
 *
 * Coordinates are fine units on the 10000 x 10000 lattice; a 24 x 18 snap grid
 * makes a cell 416.67 x 555.56, and the numbers below are cell multiples.
 *
 * How the page works without any wiring code: the tables publish the row you
 * pick under an input name (templateId, sessionId, roomId), the fields publish
 * what you type (name, date, time), and every button sends all of it.  The
 * server keeps only the keys the pressed button's action declares.
 */

import { Canvas, Page, Control, stringify } from "../../../ui/core/document.js";

export const DOCUMENT_NAME = "Session Manager";

const BTN  = { color: "#1f2f8f", secondary: "#8fb4ff", textColor: "#ffffff", font: "Button Font" };
const WARN = { color: "#7a2a10", secondary: "#ffb080", textColor: "#ffffff", font: "Button Font" };
const GO   = { color: "#155d2a", secondary: "#7fe0a0", textColor: "#ffffff", font: "Button Font" };
const NAV  = { color: "#3a3a4a", secondary: "#9aa4c8", textColor: "#ffffff", font: "Button Font" };
const HEAD = { textColor: "#8fd3ff", align: "left", shadow: true, font: "Label Font" };

export function buildSessionManager() {
	const canvas = new Canvas( DOCUMENT_NAME );
	canvas.grid = { divisorX: 24, divisorY: 18 };
	canvas.fonts = {
		"Title Font":  { font: "600 3.0vh/1.2 system-ui, sans-serif" },
		"Label Font":  { font: "600 2.2vh/1.2 system-ui, sans-serif" },
		"Button Font": { font: "600 2.0vh/1.15 system-ui, sans-serif" },
	};
	canvas.setBands( 1111, 1111 );

	// -- shared bar ---------------------------------------------------------
	canvas.shared.add( new Control( "Text Label", 278, 139, 4000, 833, {
		text: "Session Manager", textColor: "#dfe4ff", align: "left", shadow: true, font: "Title Font" } ) );
	canvas.shared.add( new Control( "Text Label", 4500, 139, 3000, 833, {
		text: "%Selected Session", textColor: "#ffd27f", align: "center" } ) );
	canvas.shared.add( new Control( "Text Label", 7600, 139, 2100, 833, {
		text: "%Clock", textColor: "#9aa4c8", align: "right" } ) );
	canvas.shared.add( new Control( "security/Session", 278, 8917, 1600, 833, {
		text: "Quit", color: "#8a0f0f", secondary: "#ff4040", mode: "logout" } ) );
	canvas.shared.add( new Control( "Text Label", 2100, 8917, 7600, 833, {
		text: "%Session Result", textColor: "#b8ffb8", align: "left" } ) );

	// -- Sessions -----------------------------------------------------------
	const main = canvas.addPage( new Page( "Sessions" ) );
	main.background.color = "#1a1a22";

	// left: templates and the new-day form
	main.add( new Control( "Text Label", 278, 1250, 4300, 555, { text: "Templates", ...HEAD } ) );
	main.add( new Control( "data/Table", 278, 1805, 4300, 2500, {
		source: "sessions", sourceArgs: { mode: "templates" }, inputName: "templateId", filter: true,
		columns: [ { key: "Id", label: "#" }, { key: "name", label: "Template" },
		           { key: "games", label: "Games", align: "right" }, { key: "paytable", label: "Paytable" } ] } ) );

	main.add( new Control( "data/Field", 278, 4450, 2100, 900, {
		name: "name", label: "Session name", placeholder: "(template name + date)" } ) );
	main.add( new Control( "data/Field", 2500, 4450, 1200, 900, {
		name: "date", label: "Date", kind: "date", value: "today" } ) );
	main.add( new Control( "data/Field", 3800, 4450, 800, 900, {
		name: "time", label: "Start", kind: "time", placeholder: "template's" } ) );

	main.add( new Control( "Button", 278, 5550, 2100, 900, {
		text: "Create_New Day", action: "cloneSession", ...GO } ) );
	main.add( new Control( "Button", 2500, 5550, 2100, 900, {
		text: "Rename /_Reschedule", action: "updateSession", ...BTN } ) );

	main.add( new Control( "Text Label", 278, 6650, 4300, 1800, {
		text: "Pick a template, set the date and start time, then Create New Day.\n"
		    + "Rename / Reschedule applies the fields to the selected upcoming session.",
		textColor: "#7f8ab0", align: "left" } ) );

	// right: what is coming up, and what to do with it
	main.add( new Control( "Text Label", 5000, 1250, 4700, 555, { text: "Upcoming sessions", ...HEAD } ) );
	main.add( new Control( "data/Table", 5000, 1805, 4700, 3600, {
		source: "sessions", sourceArgs: { mode: "upcoming" }, inputName: "sessionId", filter: true,
		columns: [ { key: "Id", label: "#" }, { key: "name", label: "Session" },
		           { key: "startAt", label: "Starts" }, { key: "status", label: "Status" },
		           { key: "games", label: "Games", align: "right" }, { key: "room", label: "Room" },
		           { key: "bank", label: "Bank" } ] } ) );

	const row1 = 5550, row2 = 6650, w = 1100, gap = 100;
	const x = i => 5000 + i * ( w + gap );
	main.add( new Control( "Button", x( 0 ), row1, w, 900, {
		text: "Go_Live", action: "setSessionStatus", actionArgs: { status: "Live" }, ...GO } ) );
	main.add( new Control( "Button", x( 1 ), row1, w, 900, {
		text: "Pause", action: "setSessionStatus", actionArgs: { status: "Pause" }, ...BTN } ) );
	main.add( new Control( "Button", x( 2 ), row1, w, 900, {
		text: "Complete", action: "setSessionStatus", actionArgs: { status: "Completed" }, ...BTN } ) );
	main.add( new Control( "Button", x( 3 ), row1, w, 900, {
		text: "Delete", action: "deleteSession", ...WARN } ) );

	main.add( new Control( "Button", x( 0 ), row2, w, 900, {
		text: "Games", nextPage: "Games", ...NAV } ) );
	main.add( new Control( "Button", x( 1 ), row2, w, 900, {
		text: "Rooms", nextPage: "Rooms", ...NAV } ) );
	main.add( new Control( "Button", x( 2 ), row2, w, 900, {
		text: "Make_Template", action: "setSessionClonable", actionArgs: { clonable: true }, ...BTN } ) );
	main.add( new Control( "Button", x( 3 ), row2, w, 900, {
		text: "Recent", nextPage: "Recent", ...NAV } ) );

	// -- Games ---------------------------------------------------------------
	const games = canvas.addPage( new Page( "Games" ) );
	games.background.color = "#141c22";
	games.add( new Control( "Text Label", 278, 1250, 9400, 555, {
		text: "Games in %Selected Session", ...HEAD } ) );
	games.add( new Control( "data/Table", 278, 1805, 9400, 5900, {
		// no filter row: a session's games are read in order.  Clicking a
		// pattern cell opens the picker and lands here as setGamePattern.
		// The Edit cell opens a detail editor (slot "details" fetches the record,
		// slot "save" writes it back); both are actions the document names here.
		source: "sessionGames", dependsOn: "sessionId", filter: false, action: "setGamePattern",
		actions: { details: "gameDetails", save: "updateGame" } } ) );
	games.add( new Control( "Button", 278, 7800, 1600, 900, { text: "Back", nextPage: "Sessions", ...NAV } ) );

	// -- Rooms ---------------------------------------------------------------
	const rooms = canvas.addPage( new Page( "Rooms" ) );
	rooms.background.color = "#1c1a22";
	rooms.add( new Control( "Text Label", 278, 1250, 9400, 555, {
		text: "Rooms  -  put %Selected Session on the floor", ...HEAD } ) );
	rooms.add( new Control( "data/Table", 278, 1805, 9400, 4800, {
		source: "rooms", inputName: "roomId" } ) );
	rooms.add( new Control( "Button", 278, 6800, 2000, 900, {
		text: "Assign_Room", action: "assignSessionRoom", ...GO } ) );
	rooms.add( new Control( "Button", 2400, 6800, 2000, 900, {
		text: "Take Off_Floor", action: "clearSessionRoom", ...WARN } ) );
	rooms.add( new Control( "Button", 278, 7800, 1600, 900, { text: "Back", nextPage: "Sessions", ...NAV } ) );

	// -- Recent --------------------------------------------------------------
	const recent = canvas.addPage( new Page( "Recent" ) );
	recent.background.color = "#22141a";
	recent.add( new Control( "Text Label", 278, 1250, 9400, 555, {
		text: "Recent sessions (any status)", ...HEAD } ) );
	recent.add( new Control( "data/Table", 278, 1805, 9400, 4800, {
		// the page is capped at 60, so the filter row also asks the server
		source: "sessions", sourceArgs: { mode: "recent", limit: 60 }, inputName: "sessionId",
		filter: true, serverFilter: true } ) );
	recent.add( new Control( "Button", 278, 6800, 2000, 900, {
		text: "Make_Template", action: "setSessionClonable", actionArgs: { clonable: true }, ...BTN } ) );
	recent.add( new Control( "Button", 2400, 6800, 2000, 900, {
		text: "Not a_Template", action: "setSessionClonable", actionArgs: { clonable: false }, ...BTN } ) );
	recent.add( new Control( "Button", 4600, 6800, 2000, 900, {
		text: "Reopen_(Active)", action: "setSessionStatus", actionArgs: { status: "Active" }, ...BTN } ) );
	recent.add( new Control( "Button", 278, 7800, 1600, 900, { text: "Back", nextPage: "Sessions", ...NAV } ) );

	return canvas;
}

/** Write the seed if, and only if, no document of that name exists. */
export async function seedSessionManager( store, log = () => {} ) {
	const existing = await store.findDocument( DOCUMENT_NAME );
	if( existing ) return false;
	await store.createDocument( DOCUMENT_NAME, stringify( buildSessionManager() ) );
	log( `seeded document "${DOCUMENT_NAME}"` );
	return true;
}
