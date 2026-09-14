/**
 * @fileoverview sideplayr sessions: the server half.
 *
 * Bingo-day session creation and management -- the first piece of the client
 * application, ahead of assigning a bank to a session and issuing it to
 * cashiers.  This file only registers sources and actions; the SQL is in
 * sessions/logic.mjs (pure over a db, and what the test drives), the database
 * is opened by sessions/db.mjs, and the "Session Manager" document that uses
 * all of it is seeded from sessions/document.mjs.
 *
 * Who is acting comes from the session the ticket established: the gameproxy
 * slice carries employeeId, which becomes CreatedBy on a new session.  With no
 * ticket (an anonymous connection, as in development) the template's own
 * creator is kept, and the log says so.
 *
 * Security is NOT declared on these actions here.  It belongs on the controls
 * in the document, where a hall sets it in the designer against its own
 * position/permission vocabulary (control.security = { gameproxy: {...} }); an
 * action-level requirement would be one every deployment had to share.
 */

import { resolve } from "node:path";
import { registerSource } from "../sources.mjs";
import { registerAction } from "../actions.mjs";
import { config, SERVICE_ROOT } from "../config.mjs";
import * as store from "../db.mjs";
import { openSideplayr } from "./sessions/db.mjs";
import { createSessionLogic, DEFAULT_CLONE_TABLES, GAME_FIELDS } from "./sessions/logic.mjs";
import { seedSessionManager } from "./sessions/document.mjs";
import { createProxyNotifier } from "./sessions/proxy.mjs";

const log = ( ...a ) => console.log( "[sessions]", ...a );

const settings = config.sideplayr || {};
const corePath = resolve( SERVICE_ROOT, settings.corePath || "../../../sideplayr/sideplayr_core" );
const dsn = process.env.SIDEPLAYR_DSN || ( settings.db && settings.db.DSN ) || null;

let logic = null;
let openError = null;
try {
	const { db, schema } = await openSideplayr( { dsn, corePath } );
	logic = createSessionLogic( { db, schema, log,
		cloneTables: Array.isArray( settings.cloneTables ) ? settings.cloneTables : DEFAULT_CLONE_TABLES } );
	log( "database open:", dsn, "- classes from", corePath );
} catch( err ) {
	openError = err;
	log( "database NOT open:", err.message, "- sources and actions will refuse until it is" );
}

function ready() {
	if( !logic ) throw new Error( "sideplayr database not available: " + ( openError && openError.message ) );
	return logic;
}

/** employees.Id from the ticket's gameproxy slice, or null when anonymous. */
function employeeOf( session ) {
	const g = session && session.gameproxy;
	return g && g.employeeId != null ? Number( g.employeeId ) : null;
}

const SESSION_COLUMNS = [
	{ key: "Id",       label: "#" },
	{ key: "name",     label: "Session" },
	// ISO instants; the Table renders these in the viewer's zone
	{ key: "startAt",  label: "Starts", type: "datetime" },
	{ key: "endAt",    label: "Ends",   type: "time" },
	{ key: "status",   label: "Status" },
	{ key: "games",    label: "Games", align: "right" },
	{ key: "room",     label: "Room" },
	{ key: "template", label: "Template" },
	{ key: "bank",     label: "Bank" },
];

// -- sources ----------------------------------------------------------------

registerSource( "sessions", {
	label: "Bingo sessions",
	args: {
		mode:  { type: "string", label: "Which: templates | upcoming | today | recent | all" },
		limit: { type: "number", label: "Row limit" },
	},
	// 'search', not 'name': the new-day form publishes a Field called 'name',
	// and every query carries every input, so a filter called 'name' would
	// narrow the lists to whatever was typed as the new session's name.
	input: {
		search:  { type: "string", label: "Name contains" },
		// what a Table with serverFilter sends from its filter row
		filters: { type: "list",   label: "[ {field, value} ] from a filter row" },
	},
	columns: SESSION_COLUMNS,
	run( { args, input } ) {
		const filters = Array.isArray( input.filters ) ? input.filters : [];
		const byName = filters.find( f => f.field === "name" );
		const rows = ready().listSessions( { mode: args.mode || "upcoming", limit: args.limit,
		                                     name: input.search || ( byName && byName.value ) || "" } );
		// the rest of the filter row narrows the page the same way the grid does
		return rows.filter( r => filters.every( f => f.field === "name" || !f.value
			|| String( r[ f.field ] ?? "" ).toLowerCase().includes( String( f.value ).toLowerCase() ) ) );
	},
} );

// Where the pattern service is, for the browser: the "pattern" column carries
// it, so the games table can import the preview and the picker from there.
const patternService = settings.patternService || "http://localhost:8085";

registerSource( "sessionGames", {
	label: "Games of the selected session",
	input: { sessionId: { type: "number", label: "Session" } },
	columns: [
		{ key: "order",    label: "Order", align: "right" },
		{ key: "no",       label: "Game #", align: "right" },
		// the alias is what the floor calls a game; the name is "Game 7"
		{ key: "alias",    label: "Game" },
		{ key: "pattern",  label: "Pattern", type: "pattern", service: patternService },
		{ key: "paytable", label: "Paytable" },
		{ key: "balls",    label: "Balls", align: "right" },
		{ key: "regular",  label: "Regular", type: "bool", align: "center" },
		// a button; the "details" cell type opens the editor through the
		// table's named actions (details / save)
		{ key: "edit",     label: " ", type: "details", align: "center" },
	],
	run( { input } ) { return ready().listGames( { sessionId: input.sessionId } ); },
} );

registerSource( "rooms", {
	label: "Game rooms",
	columns: [
		{ key: "Id",      label: "#" },
		{ key: "name",    label: "Room" },
		{ key: "session", label: "Running" },
	],
	run() { return ready().listRooms(); },
} );

registerSource( "sessionStatuses", {
	label: "Session status names",
	columns: [ { key: "Id", label: "#" }, { key: "Name", label: "Status" } ],
	run() { return ready().statuses(); },
} );

// -- actions ----------------------------------------------------------------

// Every change: tell the windows on this service (broadcast) and the game
// proxy (backchannel), so the caller and floor pick the new list up too.
const proxy = createProxyNotifier( { url: settings.gameProxy || "ws://localhost:8087/", log } );
const changed = ( value ) => {
	proxy.refreshSessions( value.sessionId );
	return { value, broadcast: { op: "sessionsChanged", ...value } };
};

registerAction( "cloneSession", {
	label: "Create a new bingo day from the selected template",
	input: {
		templateId: { type: "number", label: "Template session" },
		name:       { type: "string", label: "New session name" },
		date:       { type: "string", label: "Date (YYYY-MM-DD)" },
		time:       { type: "string", label: "Start (HH:MM)" },
		tzOffset:   { type: "number", label: "Browser zone offset (minutes)" },
	},
	run( { input, session } ) {
		if( !input.templateId ) throw new Error( "pick a template first" );
		const createdBy = employeeOf( session );
		if( createdBy === null ) log( "cloneSession by an anonymous connection; keeping the template's creator" );
		const result = ready().cloneSession( { sourceId: input.templateId, name: input.name,
			date: input.date, time: input.time, tzOffset: input.tzOffset, createdBy } );
		return changed( { sessionId: result.id, action: "cloned", ...result } );
	},
} );

registerAction( "updateSession", {
	label: "Rename / reschedule the selected session",
	input: {
		sessionId: { type: "number", label: "Session" },
		name:      { type: "string", label: "Name" },
		date:      { type: "string", label: "Date (YYYY-MM-DD)" },
		time:      { type: "string", label: "Start (HH:MM)" },
		tzOffset:  { type: "number", label: "Browser zone offset (minutes)" },
	},
	run( { input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		return changed( { action: "updated", ...ready().updateSession( { id: input.sessionId,
			name: input.name, date: input.date, time: input.time, tzOffset: input.tzOffset } ) } );
	},
} );

registerAction( "setSessionStatus", {
	label: "Set the selected session's status",
	args:  { status: { type: "string", label: "Status (Active, Live, Pause, Completed, Review)" } },
	input: { sessionId: { type: "number", label: "Session" } },
	run( { args, input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		return changed( { action: "status", sessionId: input.sessionId,
			...ready().setStatus( { id: input.sessionId, status: args.status } ) } );
	},
} );

registerAction( "setSessionClonable", {
	label: "Mark / unmark the selected session as a template",
	args:  { clonable: { type: "bool", label: "Is a template" } },
	input: { sessionId: { type: "number", label: "Session" } },
	run( { args, input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		return changed( { action: "template", sessionId: input.sessionId,
			...ready().setClonable( { id: input.sessionId, clonable: !!args.clonable } ) } );
	},
} );

registerAction( "deleteSession", {
	label: "Delete the selected session (soft)",
	input: { sessionId: { type: "number", label: "Session" } },
	run( { input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		return changed( { action: "deleted", sessionId: input.sessionId,
			...ready().deleteSession( { id: input.sessionId } ) } );
	},
} );

registerAction( "assignSessionRoom", {
	label: "Run the selected session in the selected room",
	input: {
		sessionId: { type: "number", label: "Session" },
		roomId:    { type: "number", label: "Room" },
	},
	run( { input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		if( !input.roomId )    throw new Error( "pick a room first" );
		return changed( { action: "room", sessionId: input.sessionId,
			...ready().assignRoom( { id: input.sessionId, roomId: input.roomId } ) } );
	},
} );

registerAction( "clearSessionRoom", {
	label: "Take the selected session off the floor",
	input: { sessionId: { type: "number", label: "Session" } },
	run( { input } ) {
		if( !input.sessionId ) throw new Error( "pick a session first" );
		return changed( { action: "room", sessionId: input.sessionId,
			...ready().clearRoom( { id: input.sessionId } ) } );
	},
} );

registerAction( "setGamePattern", {
	label: "Give a game a different pattern",
	input: {
		gameId:    { type: "number", label: "Game" },
		patternId: { type: "number", label: "Pattern" },
	},
	run( { input } ) {
		if( !input.gameId )    throw new Error( "no game" );
		if( !input.patternId ) throw new Error( "no pattern" );
		return changed( { action: "pattern", ...ready().setGamePattern( { gameId: input.gameId, patternId: input.patternId } ) } );
	},
} );

// The game detail editor: one action hands the client a field schema with
// the game's values and the option lists, the other takes edited values back.
// The input schema of updateGame is generated from the same field list, so a
// field added in logic.mjs is editable without touching this file.
registerAction( "gameDetails", {
	label: "Fetch a game's editable details (for the detail editor)",
	input: { gameId: { type: "number", label: "Game" } },
	run( { input } ) {
		if( !input.gameId ) throw new Error( "no game" );
		const details = ready().gameDetails( { gameId: input.gameId } );
		// the pattern field opens the picker; it needs to know where the service is
		for( const f of details.fields ) if( f.type === "pattern" ) f.service = patternService;
		return details;
	},
} );

registerAction( "updateGame", {
	label: "Save a game's details",
	input: Object.assign( { gameId: { type: "number", label: "Game" } },
		...GAME_FIELDS.filter( f => f.key ).map( f => ( { [ f.key ]: {
			type: f.type === "bool" ? "bool" : f.type === "number" || f.type === "choice" || f.type === "pattern" ? "number" : "string",
			label: f.label } } ) ) ),
	run( { input } ) {
		if( !input.gameId ) throw new Error( "no game" );
		const { gameId, ...fields } = input;
		return changed( { action: "game", ...ready().updateGame( { gameId, fields } ) } );
	},
} );

// -- the document -----------------------------------------------------------

try { await seedSessionManager( store, log ); }
catch( err ) { log( "could not seed the Session Manager document:", err.message ); }

log( "plugin loaded (sources: sessions, sessionGames, rooms, sessionStatuses;"
   + " actions: cloneSession, updateSession, setSessionStatus, setSessionClonable,"
   + " deleteSession, assignSessionRoom, clearSessionRoom, setGamePattern;"
   + " pattern service " + patternService + ")" );
