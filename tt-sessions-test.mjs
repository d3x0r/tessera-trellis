/**
 * The sessions plugin's logic, on a throwaway sqlite file.
 *
 * Builds the tables from the sideplayr_core classes (so the column lists the
 * clone copies are the real ones), plants a template session with games and
 * pack rules, and checks that cloning makes a fresh day out of it.
 *
 * Needs the sideplayr_core tree config.jsox points at (or SIDEPLAYR_CORE).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, SERVICE_ROOT } from "./server/config.mjs";
import { openSideplayr, createTables } from "./server/plugins/sessions/db.mjs";
import { createSessionLogic, sqlDateTime, asDate } from "./server/plugins/sessions/logic.mjs";

const here = dirname( fileURLToPath( import.meta.url ) );
let pass = 0, fail = 0;
const check = ( n, c, x ) => c ? ( pass++, console.log( "  ok   " + n ) )
                               : ( fail++, console.log( "  FAIL " + n, x === undefined ? "" : x ) );

const corePath = process.env.SIDEPLAYR_CORE
	|| resolve( SERVICE_ROOT, ( config.sideplayr && config.sideplayr.corePath ) || "../../../sideplayr/sideplayr_core" );

const dir = mkdtempSync( join( tmpdir(), "tt-sessions-" ) );
const file = join( dir, "sessions.db" );

let db, schema, classes;
try {
	( { db, schema, classes } = await openSideplayr( { dsn: file, corePath } ) );
	check( "opened a sqlite database from the sideplayr_core classes", !!db && !!schema.game_sessions );
} catch( err ) {
	check( "opened a sqlite database from the sideplayr_core classes", false, err.message );
	console.log( `\n${pass} passed, ${fail} failed` );
	process.exit( 1 );
}

createTables( db, classes );
const logic = createSessionLogic( { db, schema, log: () => {} } );

console.log( "-- helpers --" );
check( "asDate parses a sql datetime", asDate( "2026-09-13 18:30:00" ).getHours() === 18 );
check( "asDate returns null for junk", asDate( "nope" ) === null );
check( "sqlDateTime round-trips", sqlDateTime( asDate( "2026-09-13 18:30:05" ) ) === "2026-09-13 18:30:05" );

console.log( "-- seed a template --" );
db.do( `INSERT INTO game_sessions (SessionName, GameTypeId, NoOfGames, SessionDateTime, SessionEndDateTime,
	TimeBetweenBalls, TimeBetweenGames, CashBallPayoutTypeId, IsBonus, BonusPayoutTypeId, IsCollectionSet,
	CollectionTemplateId, JackpotPrize, CreatedBy, CustomerId, Status, PaytableName, isClonable)
	VALUES ('Evening Regular', 1, 0, '2026-01-05 18:30:00', '2026-01-05 21:30:00', 3, 60, 0, 0, 0, 0, 0, 0, 77, 1, 3, 'Regular Paytable', 1)` );
const tpl = db.do( "SELECT * FROM game_sessions" )[ 0 ];
check( "template row exists", tpl && tpl.SessionName === "Evening Regular", tpl );

for( let n = 1; n <= 3; n++ )
	db.do( `INSERT INTO games (GameSessionId, GameName, GameNo, GameOrder, PatternName, PaytableId, CustomerId, BallCount,
		GameBallStatus, Status, IsRegularGame, GameCardTypeId, PatternId, JackpotFlag, BulletCellPrize, BulletTotalPrize,
		IsCountDownBall, CountDownPayoutTypeId, UserMin, UserMax)
		VALUES (?, ?, ?, ?, ?, 5, 1, 75, 9, 6, 1, 2, ?, 0, 0, 0, 0, 0, 1, 500)`,
		tpl.Id, "Game " + n, n, n, "Pattern " + n, 100 + n );
const tplGames = db.do( "SELECT Id FROM games WHERE GameSessionId=? ORDER BY GameOrder", tpl.Id );
check( "template has 3 games", tplGames.length === 3 );

db.do( "INSERT INTO session_package_types (GameSessionId, PackageTypeId, Status, GameId) VALUES (?, 11, 1, ?)", tpl.Id, tplGames[ 0 ].Id );
db.do( "INSERT INTO session_package_types (GameSessionId, PackageTypeId, Status, GameId) VALUES (?, 12, 1, ?)", tpl.Id, tplGames[ 2 ].Id );
db.do( "INSERT INTO session_package_types (GameSessionId, PackageTypeId, Status, GameId) VALUES (?, 13, 1, 999999)", tpl.Id );
db.do( "INSERT INTO session_pos_layouts (session_id, inventory_id, inventory_type, e_p_order) VALUES (?, 3, 'package', 1)", tpl.Id );
db.do( "INSERT INTO game_rooms (Name) VALUES ('Main Hall')" );
db.do( "INSERT INTO game_rooms (Name) VALUES ('Annex')" );

console.log( "-- lists --" );
let templates = logic.listSessions( { mode: "templates" } );
check( "templates mode lists the template", templates.length === 1 && templates[ 0 ].template === "yes", templates );
check( "template row counts its games", templates[ 0 ].games === 3, templates[ 0 ] );
check( "upcoming mode does not list a 2026-01 session", logic.listSessions( { mode: "upcoming" } ).length === 0 );
check( "name filter works", logic.listSessions( { mode: "all", name: "Evening" } ).length === 1 );
check( "name filter excludes", logic.listSessions( { mode: "all", name: "Morning" } ).length === 0 );
check( "rooms list", logic.listRooms().length === 2 );
check( "statuses fall back to defaults when the table is empty", logic.statuses().length === 8 );
check( "statusId resolves a name", logic.statusId( "Live" ) === 4 );
check( "statusId passes a number", logic.statusId( 6 ) === 6 );
check( "statusId rejects junk", logic.statusId( "Bogus" ) === null );

console.log( "-- clone --" );
check( "dbNow reads the database clock", Math.abs( logic.dbNow().getTime() - Date.now() ) < 5000, logic.dbNow() );
const today = sqlDateTime( logic.dbNow() ).slice( 0, 10 );
const r = logic.cloneSession( { sourceId: tpl.Id, date: today, time: "19:00", createdBy: 4299 } );
check( "clone returns a new id", r.id && r.id !== tpl.Id, r );
check( "clone copied 3 games", r.games === 3, r );
check( "clone kept 2 pack rules and dropped the one for a missing game", r.packageTypes === 2, r );
check( "clone carried the POS layout", r.extras.session_pos_layouts === 1, r.extras );
check( "default name is template name + date", r.name === "Evening Regular " + today, r.name );

const day = logic.getSession( r.id );
check( "new day starts at the requested time", String( day.SessionDateTime ).startsWith( today + " 19:00" ), day.SessionDateTime );
check( "new day keeps the template's 3h duration", String( day.SessionEndDateTime ).startsWith( today + " 22:00" ), day.SessionEndDateTime );
check( "new day remembers its parent", Number( day.ParentSessionId ) === Number( tpl.Id ) );
check( "new day is Active", Number( day.Status ) === 2, day.Status );
check( "new day is not itself a template", Number( day.isClonable ) === 0 );
check( "new day has no bank yet", day.bank_relation_id === null || day.bank_relation_id === undefined, day.bank_relation_id );
check( "CreatedBy is the acting employee", Number( day.CreatedBy ) === 4299, day.CreatedBy );
check( "NoOfGames updated", Number( day.NoOfGames ) === 3 );
check( "template kept its paytable name on the copy", day.PaytableName === "Regular Paytable" );

const newGames = db.do( "SELECT * FROM games WHERE GameSessionId=? ORDER BY GameOrder", r.id );
check( "cloned games keep names/order", newGames.map( g => g.GameName ).join() === "Game 1,Game 2,Game 3" );
check( "cloned games have runtime state reset", newGames.every( g => Number( g.GameBallStatus ) === 0 && Number( g.Status ) === 2 ), newGames.map( g => [ g.GameBallStatus, g.Status ] ) );
check( "cloned games keep configuration", newGames.every( g => Number( g.BallCount ) === 75 && Number( g.PaytableId ) === 5 ) );
const rules = db.do( "SELECT * FROM session_package_types WHERE GameSessionId=? ORDER BY PackageTypeId", r.id );
check( "pack rules point at the NEW games", rules[ 0 ].GameId == newGames[ 0 ].Id && rules[ 1 ].GameId == newGames[ 2 ].Id, rules );

check( "clone by default uses today and the template's start time", ( () => {
	const q = logic.cloneSession( { sourceId: tpl.Id } );
	const s = logic.getSession( q.id );
	return String( s.SessionDateTime ).startsWith( today + " 18:30" ) && String( s.CreatedBy ) === "77";
} )() );
check( "clone refuses a bad date", ( () => { try { logic.cloneSession( { sourceId: tpl.Id, date: "tomorrow" } ); return false; } catch( e ) { return /date/.test( e.message ); } } )() );
check( "clone refuses a missing source", ( () => { try { logic.cloneSession( { sourceId: 424242 } ); return false; } catch( e ) { return /no session/.test( e.message ); } } )() );

console.log( "-- zones --" );
{
	// listSessions hands out instants: the stored wall-clock read back at the db's offset
	const listed = logic.listSessions( { mode: "all" } ).find( s => s.Id === Number( tpl.Id ) );
	const wall = asDate( tpl.SessionDateTime );
	check( "startAt is the stored wall-clock as an instant at the db offset",
		listed.startAt === logic.instantOf( wall, logic.dbOffsetMs() ).toISOString(), [ listed.startAt, wall ] );
	check( "isoOf agrees", logic.isoOf( tpl.SessionDateTime ) === listed.startAt );

	// a person two hours WEST of the database types 19:00; the db stores 21:00
	const dbMinutesWest = -logic.dbOffsetMs() / 60000;
	const q = logic.cloneSession( { sourceId: tpl.Id, date: "2030-06-10", time: "19:00", tzOffset: dbMinutesWest + 120 } );
	const s = logic.getSession( q.id );
	check( "typed time is read in the person's zone and stored in the database's",
		String( s.SessionDateTime ).startsWith( "2030-06-10 21:00" ), s.SessionDateTime );
	check( "the reported instant is 19:00 in the person's zone",
		logic.wallIn( new Date( q.startAt ), -( dbMinutesWest + 120 ) * 60000 ).getHours() === 19, q.startAt );
	check( "duration survives the zone trip", String( s.SessionEndDateTime ).startsWith( "2030-06-11 00:00" ), s.SessionEndDateTime );

	// same person, no time given: today at the template's start as THEY see it (18:30 db -> 16:30 theirs)
	const q2 = logic.cloneSession( { sourceId: tpl.Id, date: "2030-06-11", tzOffset: dbMinutesWest + 120 } );
	check( "default start keeps the template's instant across zones",
		String( logic.getSession( q2.id ).SessionDateTime ).startsWith( "2030-06-11 18:30" ), logic.getSession( q2.id ).SessionDateTime );

	check( "wallIn/instantOf round-trip", ( () => {
		const w = new Date( 2030, 0, 15, 7, 45, 0 );
		return sqlDateTime( logic.wallIn( logic.instantOf( w, 3600000 ), 3600000 ) ) === "2030-01-15 07:45:00";
	} )() );
	logic.deleteSession( { id: q.id } );
	logic.deleteSession( { id: q2.id } );
}

console.log( "-- game patterns --" );
{
	db.do( "INSERT INTO pattern_types (Id, PatternType, CardTypeId, GameCardTypeId, GameTypeId, Status) VALUES (101, 'Pattern 1', 2, 2, 1, 1)" );
	db.do( "INSERT INTO pattern_types (Id, PatternType, CardTypeId, GameCardTypeId, GameTypeId, Status) VALUES (777, 'Small Frame', 2, 2, 1, 1)" );
	const g = logic.listGames( { sessionId: tpl.Id } );
	check( "games carry patternId, gameCardTypeId and a boolean regular flag",
		g[ 0 ].patternId === 101 && g[ 0 ].gameCardTypeId === 2 && g[ 0 ].regular === true, g[ 0 ] );
	const p = logic.setGamePattern( { gameId: g[ 0 ].Id, patternId: 777 } );
	check( "setGamePattern reports the change", p.pattern === "Small Frame" && p.sessionId === Number( tpl.Id ), p );
	const again = logic.listGames( { sessionId: tpl.Id } )[ 0 ];
	check( "the game now has the new pattern id and name", again.patternId === 777 && again.pattern === "Small Frame", again );
	check( "unknown pattern refused", ( () => { try { logic.setGamePattern( { gameId: g[ 0 ].Id, patternId: 5 } ); return false; } catch( e ) { return /no pattern/.test( e.message ); } } )() );
	check( "unknown game refused", ( () => { try { logic.setGamePattern( { gameId: 9999, patternId: 777 } ); return false; } catch( e ) { return /no game/.test( e.message ); } } )() );
}

console.log( "-- game details --" );
{
	db.do( "INSERT INTO game_card_types (Id, CardTypeName, GameTypeId, CardTypeId, Status, MaxDaubCount, CardValue) VALUES (2, 'Regular 5x5', 1, 2, 1, 25, 0)" );
	for( const [ id, name ] of [ [ 96, "Horserace P" ], [ 117, "Early Bird" ] ] )
		db.do( `INSERT INTO package_types (Id, PackageName, GameCardTypeId, GameTypeId, CustomerId, Status, CreatedBy, Price,
			AvailablePage, CardsPerPage, Color, IsBonusPackage) VALUES (?, ?, 2, 1, 1, 1, 1, 0, 1, 3, '#fff', 0)`, id, name );
	db.do( "INSERT INTO payouts (Id, Name, PayoutTypeId, GameTypeId, GameCardTypeId, Status, CustomerId) VALUES (5, 'Old Table', 1, 1, 2, 1, 1)" );
	db.do( "INSERT INTO payouts (Id, Name, PayoutTypeId, GameTypeId, GameCardTypeId, Status, CustomerId) VALUES (23, '15 at 1500', 1, 1, 2, 1, 1)" );
	db.do( "INSERT INTO payout_rules (PayoutId, PackageTypeId, PayoutPaymentTypeId, FromBall, ToBall, DaubCount, BingoOn, Place, PrizeAmount, Status, GameTypeId) VALUES (23, 96, 1, 0, 75, 0, 0, 1, 100, 1, 1)" );
	const g = logic.listGames( { sessionId: tpl.Id } )[ 1 ];
	const d = logic.gameDetails( { gameId: g.Id } );
	check( "pack options say which paytables pay them", ( () => {
		const packs = d.fields.find( f => f.key === "PackageTypeId" ).options;
		return packs.find( p => p.value === 96 ).paytables.includes( 23 ) && packs.find( p => p.value === 117 ).paytables.length === 0;
	} )(), d.fields.find( f => f.key === "PackageTypeId" ).options );
	check( "details carry the session's paytable", "sessionPaytableId" in d );
	check( "games list carries the alias", "alias" in g );
	check( "details carry a schema with resolved options", d.fields.find( f => f.key === "PaytableId" ).options.length === 2, d.fields.find( f => f.key === "PaytableId" ) );
	check( "details carry values keyed by column", d.values.GameName === "Game 2" && d.values.BallCount === 75, d.values );
	check( "bool values arrive as booleans", d.values.IsPreBall === false );
	check( "packs arrive as an id list", Array.isArray( d.values.PackageTypeId ) );

	const u = logic.updateGame( { gameId: g.Id, fields: { GameName: "Game Two", IsPreBall: true, PreBallCount: 3,
		PaytableId: 23, PatternId: 777, PackageTypeId: "96,117", TimeBetweenBalls: "2500" } } );
	check( "update reports the write", u.changed && u.fields >= 7 && u.packsAdded === 2, u );
	const row = db.do( "SELECT * FROM games WHERE Id=?", g.Id )[ 0 ];
	check( "text, bool and number columns written", row.GameName === "Game Two" && Number( row.IsPreBall ) === 1 && Number( row.PreBallCount ) === 3 && Number( row.TimeBetweenBalls ) === 2500, row );
	check( "denormalised names follow their ids", row.PaytableName === "15 at 1500" && row.PatternName === "Small Frame", [ row.PaytableName, row.PatternName ] );
	check( "packs stored as CSV", row.PackageTypeId === "96,117", row.PackageTypeId );
	const spt = db.do( "SELECT PackageTypeId FROM session_package_types WHERE GameId=? AND deleted_at IS NULL ORDER BY PackageTypeId", g.Id ).map( r => Number( r.PackageTypeId ) );
	check( "and as one session_package_types row each", spt.join() === "96,117", spt );

	const u2 = logic.updateGame( { gameId: g.Id, fields: { PackageTypeId: "117" } } );
	check( "removing a pack soft-deletes its row", u2.packsRemoved === 1 && db.do( "SELECT COUNT(*) n FROM session_package_types WHERE GameId=? AND deleted_at IS NULL", g.Id )[ 0 ].n == 1, u2 );
	check( "unknown fields are ignored", logic.updateGame( { gameId: g.Id, fields: { Nope: 1 } } ).changed === false );
	check( "bad number refused", ( () => { try { logic.updateGame( { gameId: g.Id, fields: { BallCount: "lots" } } ); return false; } catch( e ) { return /number/.test( e.message ); } } )() );
}

console.log( "-- manage --" );
check( "upcoming now lists the new days", logic.listSessions( { mode: "upcoming" } ).length === 2 );
check( "today mode lists them too", logic.listSessions( { mode: "today" } ).length === 2 );

let u = logic.updateSession( { id: r.id, name: "Saturday Night" } );
check( "rename", u.changed && logic.getSession( r.id ).SessionName === "Saturday Night" );
u = logic.updateSession( { id: r.id, time: "20:15" } );
check( "reschedule keeps the duration", ( () => {
	const s = logic.getSession( r.id );
	return String( s.SessionDateTime ).includes( " 20:15" ) && String( s.SessionEndDateTime ).includes( " 23:15" );
} )(), logic.getSession( r.id ) );
check( "update with nothing to do says so", logic.updateSession( { id: r.id } ).changed === false );

check( "go live", logic.setStatus( { id: r.id, status: "Live" } ).statusId === 4 );
check( "delete refuses a live session", ( () => { try { logic.deleteSession( { id: r.id } ); return false; } catch( e ) { return /live/.test( e.message ); } } )() );

const roomNamed = ( name ) => logic.listRooms().find( x => x.name === name );
let a = logic.assignRoom( { id: r.id, roomId: roomNamed( "Main Hall" ).Id } );
check( "assign room", a.room === "Main Hall" && roomNamed( "Main Hall" ).sessionId === r.id, logic.listRooms() );
check( "session list shows the room", logic.listSessions( { mode: "today" } ).find( s => s.Id === r.id ).room === "Main Hall" );
a = logic.assignRoom( { id: r.id, roomId: roomNamed( "Annex" ).Id } );
check( "moving room frees the old one", ( () => {
	const l = logic.listRooms();
	return l.find( x => x.name === "Main Hall" ).sessionId === "" && l.find( x => x.name === "Annex" ).sessionId === r.id;
} )(), logic.listRooms() );
check( "assign refuses a bad room", ( () => { try { logic.assignRoom( { id: r.id, roomId: 999 } ); return false; } catch( e ) { return /no room/.test( e.message ); } } )() );

check( "complete", logic.setStatus( { id: r.id, status: "Completed" } ).status === "Completed" );
check( "completed sessions leave 'upcoming'", !logic.listSessions( { mode: "upcoming" } ).some( s => s.Id === r.id ) );
check( "but stay in 'recent'", logic.listSessions( { mode: "recent" } ).some( s => s.Id === r.id ) );

check( "mark as template", logic.setClonable( { id: r.id, clonable: true } ).template === true
	&& logic.listSessions( { mode: "templates" } ).length === 2 );
check( "unmark", logic.setClonable( { id: r.id, clonable: false } ).template === false );

const d = logic.deleteSession( { id: r.id } );
check( "delete (soft)", d.deleted && logic.getSession( r.id ) === null );
check( "delete frees the room", logic.listRooms().every( x => x.sessionId === "" ), logic.listRooms() );
check( "deleted sessions vanish from every list", !logic.listSessions( { mode: "all" } ).some( s => s.Id === r.id ) );
check( "status 'Deleted' is a delete", ( () => {
	const q = logic.cloneSession( { sourceId: tpl.Id } );
	logic.setStatus( { id: q.id, status: "Deleted" } );
	return logic.getSession( q.id ) === null;
} )() );

try { db.close && db.close(); } catch( err ) { /* ignore */ }
try { rmSync( dir, { recursive: true, force: true } ); } catch( err ) { /* a handle may linger on Windows */ }

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
