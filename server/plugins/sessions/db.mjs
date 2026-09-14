/**
 * @fileoverview The sideplayr database, for the sessions plugin.
 *
 * Opened the way the bank service opens it: sack.DB on a DSN (MariaDB) or a
 * .db path (sqlite), with the schema classes loaded from a sideplayr_core tree
 * so column lists come from the one place they are maintained rather than
 * being copied here.
 *
 * No side effects at import: openSideplayr() is called by the plugin loader
 * with the config, and by the test with a temp sqlite file.  Nothing here
 * runs makeTable against a live database -- the tables this touches are
 * sideplayr's, and migrating them is not this plugin's job.
 */

import { sack } from "sack.vfs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CLASSES = {
	game_sessions:         "session/game_sessions.mjs",
	games:                 "game/games.mjs",
	pattern_types:         "game/pattern_types.mjs",
	game_card_types:       "cards/game_card_types.mjs",
	package_types:         "items/package_types.mjs",
	payouts:               "game/payouts.mjs",
	payout_rules:          "game/payout_rules.mjs",
	jackpots:              "accruals/jackpots.mjs",
	session_package_types: "items/session_package_types.mjs",
	game_rooms:            "session/game_rooms.mjs",
	config_session_status: "session/config_session_status.mjs",
	session_pos_layouts:   "items/session_pos_layouts.mjs",
	session_scheme_inventories: "items/session_scheme_inventories.mjs",
	collection_session:    "collections/collection_session.mjs",
};

/**
 * @param {object} opts
 * @param {string} opts.dsn        ODBC DSN name or sqlite .db path
 * @param {string} opts.corePath   absolute path of a sideplayr_core tree
 * @returns {Promise<{db:object, classes:object, schema:object}>}
 *   classes: table name -> Table class;  schema: table name -> column list
 */
export async function openSideplayr( { dsn, corePath } ) {
	if( !dsn ) throw new Error( "no sideplayr DSN configured" );
	const base = resolve( corePath, "bingo", "database" );

	const db = new sack.DB( dsn );
	const { getConfig } = await import( pathToFileURL( resolve( base, "dbTypes.mjs" ) ).href );
	getConfig( db );

	const classes = {};
	const schema = {};
	for( const [ name, file ] of Object.entries( CLASSES ) ) {
		const mod = await import( pathToFileURL( resolve( base, "classes", file ) ).href );
		const cls = mod[ name ];
		if( !cls ) throw new Error( `${file} does not export ${name}` );
		classes[ name ] = cls;
		schema[ name ] = cls.columns.slice();
	}
	return { db, classes, schema };
}

/**
 * Create the tables the plugin uses; for a fresh (test) database only.
 * The MySQL spellings sqlite chokes on are rewritten the way the core's own
 * sqlite.db.mjs does it; makeTable() handles the KEY lines itself.
 */
export function createTables( db, classes ) {
	const sqlite = db.provider === 1;
	for( const cls of Object.values( classes ) ) {
		let sql = cls.createSQL;
		if( sqlite ) sql = sql
			.replaceAll( "utf8mb4_unicode_ci", "nocase" )
			.replaceAll( "utf8_unicode_ci", "nocase" )
			.replaceAll( "utf8mb4_bin", "binary" )
			.replaceAll( "ON UPDATE CURRENT_TIMESTAMP", "" )
			.replaceAll( "CHARACTER SET utf8", "" )
			// dbTypes.nameUnique spells a unique key in a way sqlite's CREATE
			// TABLE rejects; the MySQL spelling is what makeTable parses.
			.replace( /CONSTRAINT\s+\w+\s+UNIQUE ON CONFLICT FAIL KEY/g, "UNIQUE KEY" );
		// makeTable's return value is not a success flag (false with the table
		// made is common); probing the table is.
		db.makeTable( sql );
		try { db.do( `SELECT * FROM \`${cls.tableName}\` LIMIT 0` ); }
		catch( err ) { throw new Error( `could not create ${cls.tableName}: ${err.message}` ); }
	}
}
