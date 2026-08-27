/**
 * @fileoverview A seed document, used only when storage is empty.
 *
 * Document construction ONLY.  Variables and actions belong to the application
 * (apps/demo-station.js), because a document loaded from storage still refers
 * to them and this function will not have run.
 *
 * Coordinates are fine units (10000 across).  A 24 x 18 snap grid means one
 * cell is 416.67 x 555.56, so the numbers below are cell multiples.
 */

import { Canvas, Page, Control } from "./core/document.js";

export function buildDemoCanvas() {
	const canvas = new Canvas( "Demo Station" );
	canvas.grid = { divisorX: 24, divisorY: 18 };

	/*
	 * Reserve a header and a footer band, then put the common bar on the shared
	 * layer.  Page controls are confined to the body from here on.
	 */
	/* Font presets are document data, referenced by name from controls. */
	canvas.fonts = {
		"Title Font": { font: "600 3.0vh/1.2 system-ui, sans-serif" },
		"Label Font": { font: "400 2.4vh/1.2 system-ui, sans-serif" },
		"Button Font": { font: "600 2.2vh/1.15 system-ui, sans-serif" },
	};

	canvas.setBands( 1111, 1111 );          // one cell of an 18-row grid, each

	canvas.shared.add( new Control( "Text Label", 278, 139, 4000, 833, {
		text: "Tessera Trellis", textColor: "#dfe4ff", align: "left", shadow: true,
		font: "Title Font" } ) );

	canvas.shared.add( new Control( "Text Label", 6500, 139, 3200, 833, {
		text: "%Clock", textColor: "#9aa4c8", align: "right" } ) );

	canvas.shared.add( new Control( "security/Session", 278, 8917, 1800, 833, {
		text: "Quit", color: "#8a0f0f", secondary: "#ff4040", mode: "logout" } ) );

	canvas.shared.add( new Control( "Text Label", 6000, 8917, 3722, 833, {
		text: "Mode: %Host Mode Select", textColor: "#7f8ab0", align: "right" } ) );

	const main = canvas.addPage( new Page( "Main" ) );
	main.background.color = "#1a1a22";

	main.add( new Control( "Text Label", 1667, 1667, 6666, 833, {
		text: "Host Mode Select", textColor: "#8fd3ff", shadow: true } ) );

	main.add( new Control( "Button", 1667, 2222, 3333, 2222, {
		text: "Enable_Participant", color: "#0f1fd0", secondary: "#00ff00",
		// Runs on the server: durable state, so the client's opinion is irrelevant.
		action: "enableParticipant", actionArgs: { hall: "BoulderStation" } } ) );

	main.add( new Control( "Button", 5417, 2222, 3333, 2222, {
		// Runs on the client: nothing is at stake and a round trip would be silly.
		text: "Reports", color: "#0f1fd0", secondary: "#c8a000",
		nextPage: "Players" } ) );

	const probit = canvas.addPage( new Page( "Probit" ) );
	probit.background.color = "#22141a";

	probit.add( new Control( "Text Label", 1667, 1667, 6666, 1111, {
		text: "Prohibit Participants", textColor: "#ffb0b0", shadow: true } ) );

	// A data control: it names a source; the server owns the query and columns.
	probit.add( new Control( "data/Table", 1667, 3056, 6666, 3889, {
		source: "receipts", sourceArgs: { till: "T1" } } ) );

	// From a plugin: the control type only exists once players/index.js loads.
	const players = canvas.addPage( new Page( "Players" ) );
	players.background.color = "#141c22";
	players.add( new Control( "Text Label", 1667, 1667, 6666, 833, {
		text: "Player Lookup", textColor: "#9fe0ff", shadow: true } ) );
	players.add( new Control( "data/Player Search", 1667, 2778, 6666, 4444, {
		source: "players", sourceArgs: {} } ) );
	players.add( new Control( "Button", 1667, 7500, 2500, 1111, {
		text: "Back", color: "#3a3a4a", nextPage: "Main" } ) );

	probit.add( new Control( "Button", 1667, 7222, 3333, 1389, {
		text: "Back", color: "#3a3a4a", nextPage: "Main" } ) );

	return canvas;
}
