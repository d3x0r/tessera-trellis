/**
 * @fileoverview Bingo-day session management, as pure functions over a db.
 *
 * A "session" here is a game_sessions row: one bingo day's programme -- its
 * games, which packs may play in which game, the POS layout.  A new day is
 * made by CLONING a session marked as a template (isClonable), the way the
 * legacy Create_Session procedure did, except that this copies the current
 * column set instead of a 2018 subset, resets per-game runtime state, and
 * carries the per-game pack rules and per-session POS layout with it.
 *
 * Nothing here knows about websockets, sessions or documents; the plugin
 * loader wraps these in sources and actions, and the test drives them on a
 * sqlite file.  Every statement is bound with ? -- the db here is sack.DB,
 * which has no template-string escaping (see the project memory).
 */

/** config_session_status as seeded; read from the table when it has rows. */
const DEFAULT_STATUSES = [
	{ Id: 1, Name: "Deleted" },
	{ Id: 2, Name: "Active" },
	{ Id: 3, Name: "Regular In Active" },
	{ Id: 4, Name: "Live" },
	{ Id: 5, Name: "Bullet Upickem In Active" },
	{ Id: 6, Name: "Completed" },
	{ Id: 7, Name: "Pause" },
	{ Id: 8, Name: "Review" },
];
const STATUS = { DELETED: 1, ACTIVE: 2, LIVE: 4, COMPLETED: 6 };

/** Columns never copied from a source row. */
const NEVER_COPY = new Set( [ "created_at", "updated_at", "deleted_at" ] );

/**
 * Per-game runtime state a fresh clone must not inherit.  Values are what the
 * games row class defaults to (games.mjs), so a cloned game looks unplayed.
 */
const GAME_RESET = {
	GameBallStatus: 0, GameStartDateTime: null, preball_status: 0, Status: 2,
	ManualStartStatus: 0, RequestTime: null, Review_start_at: null, Review_end_at: null,
};

/**
 * Per-session configuration that travels with a clone besides games.  Each
 * names the column that holds the session id; a table that is absent from the
 * database is skipped, not fatal.  Overridable from config (sideplayr.cloneTables).
 */
export const DEFAULT_CLONE_TABLES = [
	{ table: "session_pos_layouts",        sessionCol: "session_id" },
	{ table: "session_scheme_inventories", sessionCol: "session_id" },
	{ table: "collection_session",         sessionCol: "SessionId" },
];

/**
 * What the game detail editor edits, in the order it shows them.  An entry
 * with only `group` starts a section.  Types: string, number, bool (stored
 * 1/0), choice (options: a lookup name resolved by gameDetails, or a literal
 * list), multi (a set of ids, stored the legacy way as CSV text in one column
 * AND as one session_package_types row each), pattern (the picker).
 *
 * The column names are the games table's; the labels are the legacy admin's
 * Edit Session > Game tab, where that mapping is known.  Ids without a
 * lookup here (bonus/cash ball) are edited as plain numbers until their
 * tables are understood.
 */
export const GAME_FIELDS = [
	{ group: "General" },
	{ key: "GameName",       label: "Name",              type: "string" },
	{ key: "AliasName",      label: "Alias",             type: "string" },
	{ key: "GameOrder",      label: "Order",             type: "number" },
	{ key: "GameNo",         label: "Game #",            type: "number" },
	{ key: "GameCardTypeId", label: "Card type",         type: "choice", options: "gameCardTypes" },
	{ key: "IsRegularGame",  label: "Game type",         type: "choice", options: [ { value: 1, text: "REGULAR" }, { value: 2, text: "SPECIAL" } ] },
	{ key: "PackageTypeId",  label: "Packs",             type: "multi",  options: "packageTypes" },
	{ key: "PatternId",      label: "Pattern",           type: "pattern" },
	{ key: "PaytableId",     label: "Paytable",          type: "choice", options: "paytables" },
	{ key: "BallCount",      label: "Ball count",        type: "number" },
	{ key: "TimeBetweenBalls", label: "Ball interval (ms)", type: "number" },
	{ key: "MinimumPayout",  label: "Minimum payout",    type: "number" },
	{ group: "Play" },
	{ key: "IsBonusGame",    label: "Bonus game",        type: "bool" },
	// "Continue": the next game is also this game -- keep the balls, keep calling
	{ key: "IsSubGame",      label: "Continue (keep calling into the next game)", type: "bool" },
	{ key: "IsRemoveWinner", label: "Remove winner on win", type: "bool" },
	{ key: "MultiPay",       label: "Multi pay",         type: "bool" },
	{ key: "isDouble",       label: "Double",            type: "bool" },
	// pre balls are a FIXED set called before the game; bonanza balls are
	// called dynamically -- different things, so both counts are here
	{ key: "IsPreBall",      label: "Pre balls (fixed set)", type: "bool" },
	{ key: "PreBallCount",   label: "How many pre balls", type: "number" },
	{ key: "IsBonanza",      label: "Bonanza (balls called dynamically)", type: "bool" },
	{ key: "BonanzaBallCount", label: "How many bonanza balls", type: "number" },
	{ key: "IsWildBall",     label: "Wild ball",         type: "bool" },
	{ key: "OddEvenTypeId",  label: "Wild type id",      type: "number" },
	// Jackpots are not edited here: they belong to the bingo_accruals service.
	{ group: "Bonus and cash ball (ids)" },
	{ key: "BonusBallId",    label: "Bonus ball id",     type: "number" },
	{ key: "PlyBonusId",     label: "Ply bonus id",      type: "number" },
	{ key: "CashBallId",     label: "Cash ball id",      type: "number" },
	{ key: "CashBallBonusId", label: "Cash ball bonus id", type: "number" },
	{ key: "CashBallFrenzyId", label: "Cash ball frenzy id", type: "number" },
];

const two = n => String( n ).padStart( 2, "0" );

/** "YYYY-MM-DD HH:MM:SS" -- the one datetime spelling both backends bind. */
export function sqlDateTime( d ) {
	return `${d.getFullYear()}-${two( d.getMonth() + 1 )}-${two( d.getDate() )}`
	     + ` ${two( d.getHours() )}:${two( d.getMinutes() )}:${two( d.getSeconds() )}`;
}

/**
 * A DATETIME column holds wall-clock text with no zone.  The ODBC driver hands
 * it back as a Date whose UTC fields carry that text ("12:14:07" arrives as
 * 12:14:07Z), so reading it with local getters would shift it by the machine's
 * offset -- a 12:14 template cloned to a 05:14 day, which is what happened.
 * Rebuild it as a local Date with the same wall-clock digits.
 */
export function fromDbDate( d ) {
	return new Date( d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
	                 d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds() );
}

/** A Date from whatever a datetime column came back as, or null. */
export function asDate( v ) {
	if( v === null || v === undefined || v === "" ) return null;
	if( v instanceof Date ) return isNaN( v ) ? null : fromDbDate( v );
	const s = String( v ).trim().replace( "T", " " );
	const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ ](\d\d):(\d\d)(?::(\d\d))?)?/.exec( s );
	if( !m ) { const d = new Date( s ); return isNaN( d ) ? null : d; }
	return new Date( +m[ 1 ], +m[ 2 ] - 1, +m[ 3 ], +( m[ 4 ] || 0 ), +( m[ 5 ] || 0 ), +( m[ 6 ] || 0 ) );
}

/** A value as the db will bind it: Dates become text, undefined becomes null. */
function bindable( v ) {
	if( v === undefined ) return null;
	if( v instanceof Date ) return sqlDateTime( v );
	return v;
}

/**
 * @param {object} opts
 * @param {object} opts.db        sack.DB
 * @param {object} opts.schema    table name -> column list (from the classes)
 * @param {Array}  [opts.cloneTables]
 * @param {(...a)=>void} [opts.log]
 */
export function createSessionLogic( { db, schema, cloneTables = DEFAULT_CLONE_TABLES, log = () => {} } ) {
	const sqlite = db.provider === 1;

	const rows = ( sql, ...args ) => db.do( sql, ...args ) || [];
	const one  = ( sql, ...args ) => rows( sql, ...args )[ 0 ] || null;

	/**
	 * "Now" as the DATABASE sees it, never the node process: every datetime in
	 * these tables is wall-clock text in the server's zone (the game proxy
	 * compares SessionDateTime against NOW() in SQL), so today's boundaries
	 * and a default date have to come from the same clock.  A UTC server and
	 * a -07:00 server are both right; a node process in another zone is not.
	 */
	function dbNow() {
		const r = one( sqlite ? "SELECT datetime('now','localtime') AS n" : "SELECT NOW() AS n" );
		return ( r && asDate( r.n ) ) || new Date();
	}

	/*
	 * Zones.  A DATETIME column is wall-clock text in the server's zone and
	 * nothing more; the browser wants real instants so it can show local time,
	 * and what a person types is wall-clock in THEIR zone.  Two offsets do all
	 * the converting: the database's (measured, so a server moved to UTC just
	 * works) and the browser's (sent with every press as tzOffset, in the
	 * getTimezoneOffset() sense: minutes to ADD to local to reach UTC).
	 *
	 * A "wall" Date here is one whose local fields hold the digits; it is never
	 * compared by getTime().  instantOf/wallIn are the only bridges.
	 */
	let offsetCache = { at: 0, ms: 0 };
	function dbOffsetMs() {
		if( Date.now() - offsetCache.at < 60000 ) return offsetCache.ms;
		let ms;
		if( sqlite ) ms = -new Date().getTimezoneOffset() * 60000;   // 'localtime' is the process zone
		else {
			const r = one( "SELECT TIMESTAMPDIFF(SECOND, UTC_TIMESTAMP(), NOW()) AS s" );
			ms = r ? Number( r.s ) * 1000 : 0;
		}
		offsetCache = { at: Date.now(), ms };
		return ms;
	}

	/** wall-clock digits at `offsetMs` east of UTC -> the instant */
	function instantOf( wall, offsetMs ) {
		return new Date( Date.UTC( wall.getFullYear(), wall.getMonth(), wall.getDate(),
			wall.getHours(), wall.getMinutes(), wall.getSeconds() ) - offsetMs );
	}

	/** the instant -> wall-clock digits at `offsetMs` east of UTC */
	function wallIn( instant, offsetMs ) {
		const u = new Date( instant.getTime() + offsetMs );
		return new Date( u.getUTCFullYear(), u.getUTCMonth(), u.getUTCDate(),
			u.getUTCHours(), u.getUTCMinutes(), u.getUTCSeconds() );
	}

	/** a DATETIME column value -> ISO instant text, or "" */
	function isoOf( v ) {
		const wall = asDate( v );
		return wall ? instantOf( wall, dbOffsetMs() ).toISOString() : "";
	}

	/** the browser's offset from press-time input, else the database's */
	function userOffsetMs( tzOffset ) {
		const n = Number( tzOffset );
		return tzOffset === undefined || tzOffset === null || tzOffset === "" || !Number.isFinite( n )
			? dbOffsetMs() : -n * 60000;
	}

	function lastId() {
		const r = one( sqlite ? "SELECT last_insert_rowid() AS id" : "SELECT last_insert_id() AS id" );
		return r ? Number( r.id ) : 0;
	}

	function insert( table, row ) {
		const cols = Object.keys( row );
		db.do( `INSERT INTO \`${table}\` (${cols.map( c => `\`${c}\`` ).join( "," )})`
		     + ` VALUES (${cols.map( () => "?" ).join( "," )})`,
		     ...cols.map( c => bindable( row[ c ] ) ) );
		return lastId();
	}

	/**
	 * One statement per chunk rather than one per row: a round trip on the
	 * ODBC link measured ~44ms, so a 27-game session cloned row-by-row took
	 * longer than the client waits for a reply.  Rows must share a column set,
	 * which copyOf() guarantees for rows of one table.
	 */
	function insertMany( table, list, chunk = 100 ) {
		if( !list.length ) return 0;
		const cols = Object.keys( list[ 0 ] );
		const names = cols.map( c => `\`${c}\`` ).join( "," );
		const one = `(${cols.map( () => "?" ).join( "," )})`;
		for( let i = 0; i < list.length; i += chunk ) {
			const part = list.slice( i, i + chunk );
			db.do( `INSERT INTO \`${table}\` (${names}) VALUES ${part.map( () => one ).join( "," )}`,
				...part.flatMap( row => cols.map( c => bindable( row[ c ] ) ) ) );
		}
		return list.length;
	}

	/** Copy a row's columns per the schema, minus a skip set, plus overrides. */
	function copyOf( table, src, skip, overrides ) {
		const out = {};
		for( const c of schema[ table ] ) {
			if( c === "Id" || c === "id" || NEVER_COPY.has( c ) || skip.has( c ) ) continue;
			if( !( c in src ) ) continue;
			// a datetime read from the db is re-bound as the same wall-clock text
			out[ c ] = src[ c ] instanceof Date ? fromDbDate( src[ c ] ) : src[ c ];
		}
		return Object.assign( out, overrides );
	}

	function transaction( fn ) {
		let began = false;
		try { db.transaction(); began = true; } catch( err ) { /* backend without transactions */ }
		try {
			const result = fn();
			if( began ) db.commit();
			return result;
		} catch( err ) {
			if( began ) { try { db.rollback(); } catch( e ) { /* ignore */ } }
			throw err;
		}
	}

	// -- lookups ------------------------------------------------------------

	function statuses() {
		try {
			const r = rows( "SELECT Id, Name FROM config_session_status ORDER BY Id" );
			if( r.length ) return r.map( s => ( { Id: Number( s.Id ), Name: String( s.Name ) } ) );
		} catch( err ) { /* table absent: defaults */ }
		return DEFAULT_STATUSES;
	}

	function statusId( nameOrId ) {
		if( nameOrId === undefined || nameOrId === null || nameOrId === "" ) return null;
		const n = Number( nameOrId );
		if( Number.isFinite( n ) && String( nameOrId ).trim() !== "" && !isNaN( n ) ) return n;
		const want = String( nameOrId ).trim().toLowerCase();
		const hit = statuses().find( s => s.Name.toLowerCase() === want );
		return hit ? hit.Id : null;
	}

	function statusName( id ) {
		const hit = statuses().find( s => s.Id === Number( id ) );
		return hit ? hit.Name : String( id );
	}

	function getSession( id ) {
		return one( "SELECT * FROM game_sessions WHERE Id=? AND deleted_at IS NULL", Number( id ) );
	}

	function requireSession( id ) {
		const s = getSession( id );
		if( !s ) throw new Error( `no session ${id}` );
		return s;
	}

	// -- reads --------------------------------------------------------------

	/**
	 * @param {object} opts
	 * @param {"templates"|"upcoming"|"today"|"recent"|"all"} [opts.mode]
	 * @param {string} [opts.name]   substring filter on SessionName
	 * @param {number} [opts.limit]
	 */
	function listSessions( { mode = "upcoming", name = "", limit = 100 } = {} ) {
		const where = [ "s.deleted_at IS NULL" ];
		const args = [];
		const now = dbNow();
		const dayStart = new Date( now.getFullYear(), now.getMonth(), now.getDate() );
		const dayEnd = new Date( dayStart.getTime() + 86400000 );
		let order = "s.SessionDateTime DESC, s.Id DESC";

		switch( mode ) {
		case "templates":
			where.push( "s.isClonable=1" );
			order = "s.SessionName, s.Id";
			break;
		case "upcoming":
			where.push( "s.Status NOT IN (?,?)", "s.SessionDateTime >= ?" );
			args.push( STATUS.DELETED, STATUS.COMPLETED, sqlDateTime( dayStart ) );
			order = "s.SessionDateTime, s.Id";
			break;
		case "today":
			where.push( "s.SessionDateTime >= ?", "s.SessionDateTime < ?" );
			args.push( sqlDateTime( dayStart ), sqlDateTime( dayEnd ) );
			order = "s.SessionDateTime, s.Id";
			break;
		case "recent":
		case "all":
		default:
			break;
		}
		if( name ) { where.push( "s.SessionName LIKE ?" ); args.push( "%" + name + "%" ); }

		const n = Math.max( 1, Math.min( 500, Number( limit ) || 100 ) );
		const names = statuses();
		return rows(
			`SELECT s.Id, s.SessionName, s.SessionDateTime, s.SessionEndDateTime, s.Status,
			        s.NoOfGames, s.ParentSessionId, s.isClonable, s.bank_relation_id, s.PaytableName,
			        (SELECT COUNT(*) FROM games g WHERE g.GameSessionId=s.Id AND g.deleted_at IS NULL) AS gameCount,
			        (SELECT r.Name FROM game_rooms r WHERE r.SessionId=s.Id AND r.deleted_at IS NULL ORDER BY r.Id LIMIT 1) AS room
			   FROM game_sessions s
			  WHERE ${where.join( " AND " )}
			  ORDER BY ${order}
			  LIMIT ${n}`, ...args
		).map( s => {
			const start = asDate( s.SessionDateTime ), end = asDate( s.SessionEndDateTime );
			const st = names.find( x => x.Id === Number( s.Status ) );
			return {
				Id:       Number( s.Id ),
				name:     s.SessionName,
				// instants; the browser renders them in its own zone
				startAt:  start ? instantOf( start, dbOffsetMs() ).toISOString() : "",
				endAt:    end ? instantOf( end, dbOffsetMs() ).toISOString() : "",
				status:   st ? st.Name : String( s.Status ),
				statusId: Number( s.Status ),
				games:    Number( s.gameCount ) || 0,
				room:     s.room || "",
				template: Number( s.isClonable ) ? "yes" : "",
				parent:   s.ParentSessionId ? Number( s.ParentSessionId ) : "",
				bank:     s.bank_relation_id ? Number( s.bank_relation_id ) : "",
				paytable: s.PaytableName || "",
			};
		} );
	}

	function listGames( { sessionId } ) {
		if( !Number( sessionId ) ) return [];
		return rows(
			`SELECT Id, GameNo, GameName, AliasName, PatternId, PatternName, PaytableName, GameOrder, IsRegularGame, Status,
			        BallCount, GameCardTypeId
			   FROM games WHERE GameSessionId=? AND deleted_at IS NULL
			  ORDER BY GameOrder, GameNo, Id`, Number( sessionId )
		).map( g => ( {
			Id: Number( g.Id ), no: g.GameNo, name: g.GameName, alias: g.AliasName || "",
			pattern: g.PatternName || "", patternId: Number( g.PatternId ) || 0,
			gameCardTypeId: Number( g.GameCardTypeId ) || 0,
			paytable: g.PaytableName || "", order: g.GameOrder, balls: g.BallCount,
			regular: Number( g.IsRegularGame ) === 1, status: g.Status,
		} ) );
	}

	/**
	 * Give a game another pattern.  pattern_types is the table the games row
	 * keys into; PatternName is denormalised on the game (the caller and the
	 * flashboard read it), so both columns move together.
	 */
	function setGamePattern( { gameId, patternId } ) {
		const game = one( "SELECT Id, GameSessionId, GameName FROM games WHERE Id=? AND deleted_at IS NULL", Number( gameId ) );
		if( !game ) throw new Error( `no game ${gameId}` );
		const pattern = one( "SELECT Id, PatternType FROM pattern_types WHERE Id=?", Number( patternId ) );
		if( !pattern ) throw new Error( `no pattern ${patternId}` );
		db.do( "UPDATE games SET PatternId=?, PatternName=? WHERE Id=?", Number( pattern.Id ), pattern.PatternType, Number( game.Id ) );
		return { gameId: Number( game.Id ), sessionId: Number( game.GameSessionId ),
		         patternId: Number( pattern.Id ), pattern: pattern.PatternType };
	}

	// -- game details ---------------------------------------------------------

	/** a lookup table as [ {value, text} ], empty when the table is absent */
	function lookup( sql ) {
		try { return rows( sql ).map( r => ( { value: Number( r.value ), text: String( r.text ), group: r.grp } ) ); }
		catch( err ) { log( "lookup failed:", err.message ); return []; }
	}

	function gameLookups() {
		// which paytables have payout rules for which pack: a pack chosen for a
		// game whose paytable never pays it is a mistake worth flagging
		const inPaytable = new Map();
		try {
			for( const r of rows( "SELECT DISTINCT PackageTypeId, PayoutId FROM payout_rules WHERE deleted_at IS NULL" ) ) {
				const k = Number( r.PackageTypeId );
				if( !inPaytable.has( k ) ) inPaytable.set( k, [] );
				inPaytable.get( k ).push( Number( r.PayoutId ) );
			}
		} catch( err ) { log( "payout_rules lookup failed:", err.message ); }
		const packageTypes = lookup( "SELECT Id AS value, PackageName AS text, GameCardTypeId AS grp FROM package_types WHERE deleted_at IS NULL AND (IsHidden IS NULL OR IsHidden=0) ORDER BY PackageName" );
		for( const p of packageTypes ) p.paytables = inPaytable.get( p.value ) || [];
		return {
			gameCardTypes: lookup( "SELECT Id AS value, CardTypeName AS text FROM game_card_types WHERE deleted_at IS NULL ORDER BY Id" ),
			// grp: the card type a pack belongs to; paytables: the PayoutIds with rules for it
			packageTypes,
			paytables:     lookup( "SELECT Id AS value, Name AS text FROM payouts WHERE deleted_at IS NULL ORDER BY Name" ),
			jackpots:      lookup( "SELECT id AS value, jackpotName AS text FROM jackpots WHERE deleted_at IS NULL ORDER BY jackpotName" ),
		};
	}

	/** the CSV the legacy admin writes into games.PackageTypeId, as ids */
	function packIds( csv ) {
		return String( csv ?? "" ).split( "," ).map( s => Number( s.trim() ) ).filter( n => n > 0 );
	}

	/**
	 * Everything the detail editor needs for one game: the field schema with
	 * option lists resolved, and the game's current values keyed by column.
	 */
	function gameDetails( { gameId } ) {
		const game = one( "SELECT * FROM games WHERE Id=? AND deleted_at IS NULL", Number( gameId ) );
		if( !game ) throw new Error( `no game ${gameId}` );
		const lookups = gameLookups();
		const values = {};
		const fields = GAME_FIELDS.map( f => {
			if( !f.key ) return { ...f };
			const v = game[ f.key ];
			values[ f.key ] = f.type === "bool" ? !!Number( v ) : f.type === "multi" ? packIds( v ) : v ?? null;
			const options = "string" === typeof f.options ? lookups[ f.options ] || [] : f.options;
			return { ...f, options };
		} );
		const session = one( "SELECT PaytableId FROM game_sessions WHERE Id=?", Number( game.GameSessionId ) );
		return {
			gameId: Number( game.Id ), sessionId: Number( game.GameSessionId ),
			// the proxy reads packs' rules from the SESSION's paytable; a game
			// without one of its own falls back to it
			sessionPaytableId: session ? Number( session.PaytableId ) || 0 : 0,
			title: `Game ${game.GameNo ?? ""} ${game.GameName || ""}`.trim(),
			patternName: game.PatternName || "", paytableName: game.PaytableName || "",
			gameCardTypeId: Number( game.GameCardTypeId ) || 0,
			fields, values,
		};
	}

	/**
	 * Write edited fields back.  Only keys present in `fields` change.  The
	 * denormalised names (PatternName, PaytableName) follow their ids, and the
	 * packs go to both places the legacy code reads them from: the CSV column
	 * and one session_package_types row per pack.
	 */
	function updateGame( { gameId, fields } ) {
		const game = one( "SELECT * FROM games WHERE Id=? AND deleted_at IS NULL", Number( gameId ) );
		if( !game ) throw new Error( `no game ${gameId}` );
		const byKey = new Map( GAME_FIELDS.filter( f => f.key ).map( f => [ f.key, f ] ) );
		const sets = [], args = [];
		let packs = null;
		for( const [ key, raw ] of Object.entries( fields || {} ) ) {
			const f = byKey.get( key );
			if( !f ) continue;                  // not an editable column
			let v = raw;
			if( f.type === "bool" ) v = raw ? 1 : 0;
			else if( f.type === "number" || f.type === "choice" || f.type === "pattern" ) {
				v = raw === "" || raw === null || raw === undefined ? null : Number( raw );
				if( v !== null && isNaN( v ) ) throw new Error( `${f.label} must be a number` );
			}
			else if( f.type === "multi" ) { packs = packIds( raw ); v = packs.join( "," ) || null; }
			else v = raw === null || raw === undefined ? null : String( raw );
			sets.push( `\`${key}\`=?` ); args.push( v );
			if( key === "PatternId" && v ) {
				const p = one( "SELECT PatternType FROM pattern_types WHERE Id=?", v );
				if( !p ) throw new Error( `no pattern ${v}` );
				sets.push( "PatternName=?" ); args.push( p.PatternType );
			}
			if( key === "PaytableId" && v ) {
				const p = one( "SELECT Name FROM payouts WHERE Id=?", v );
				if( p ) { sets.push( "PaytableName=?" ); args.push( p.Name ); }
			}
		}
		if( !sets.length && !packs ) return { gameId: Number( game.Id ), sessionId: Number( game.GameSessionId ), changed: false };

		return transaction( () => {
			if( sets.length ) db.do( `UPDATE games SET ${sets.join( ", " )} WHERE Id=?`, ...args, Number( game.Id ) );
			let packsAdded = 0, packsRemoved = 0;
			if( packs ) {
				const have = rows( "SELECT Id, PackageTypeId FROM session_package_types WHERE GameId=? AND deleted_at IS NULL", Number( game.Id ) );
				const want = new Set( packs );
				for( const r of have )
					if( !want.has( Number( r.PackageTypeId ) ) ) {
						db.do( "UPDATE session_package_types SET deleted_at=? WHERE Id=?", sqlDateTime( dbNow() ), Number( r.Id ) );
						packsRemoved++;
					}
				const has = new Set( have.map( r => Number( r.PackageTypeId ) ) );
				for( const id of packs )
					if( !has.has( id ) ) {
						insert( "session_package_types", { GameSessionId: Number( game.GameSessionId ), PackageTypeId: id, Status: 1, GameId: Number( game.Id ) } );
						packsAdded++;
					}
			}
			const after = one( "SELECT GameName, GameNo FROM games WHERE Id=?", Number( game.Id ) );
			return { gameId: Number( game.Id ), sessionId: Number( game.GameSessionId ), changed: true,
			         name: after.GameName, no: after.GameNo, fields: sets.length, packsAdded, packsRemoved };
		} );
	}

	function listRooms() {
		return rows(
			`SELECT r.Id, r.Name, r.SessionId, s.SessionName
			   FROM game_rooms r LEFT JOIN game_sessions s ON s.Id=r.SessionId
			  WHERE r.deleted_at IS NULL ORDER BY r.Name`
		).map( r => ( { Id: Number( r.Id ), name: r.Name,
		                sessionId: r.SessionId ? Number( r.SessionId ) : "",
		                session: r.SessionName || "" } ) );
	}

	// -- writes -------------------------------------------------------------

	/**
	 * Start/end for a new day: the requested date+time, else today at the
	 * source's time -- all of it read in the PERSON's zone (tzOffset), then
	 * stored as the database's wall-clock.  Returns db-wall Dates plus the
	 * instants, so callers store the one and report the other.
	 */
	function scheduleFrom( src, date, time, tzOffset ) {
		const dbOff = dbOffsetMs();
		const userOff = userOffsetMs( tzOffset );

		const srcStartWall = asDate( src.SessionDateTime ) || dbNow();
		const srcEndWall = asDate( src.SessionEndDateTime );
		const srcStart = instantOf( srcStartWall, dbOff );
		let duration = srcEndWall ? instantOf( srcEndWall, dbOff ).getTime() - srcStart.getTime() : 0;
		if( !( duration > 0 ) ) duration = 4 * 3600000;

		// "today" and "the template's start time", as the person sees them
		const todayUser = wallIn( instantOf( dbNow(), dbOff ), userOff );
		const srcStartUser = wallIn( srcStart, userOff );

		let y = todayUser.getFullYear(), mo = todayUser.getMonth(), d = todayUser.getDate();
		if( date ) {
			const m = /^(\d{4})-(\d\d)-(\d\d)/.exec( String( date ) );
			if( !m ) throw new Error( "date must be YYYY-MM-DD" );
			y = +m[ 1 ]; mo = +m[ 2 ] - 1; d = +m[ 3 ];
		}
		let hh = srcStartUser.getHours(), mm = srcStartUser.getMinutes();
		if( time ) {
			const m = /^(\d\d?):(\d\d)/.exec( String( time ) );
			if( !m ) throw new Error( "time must be HH:MM" );
			hh = +m[ 1 ]; mm = +m[ 2 ];
		}
		const startAt = instantOf( new Date( y, mo, d, hh, mm, 0 ), userOff );
		const endAt = new Date( startAt.getTime() + duration );
		return { start: wallIn( startAt, dbOff ), end: wallIn( endAt, dbOff ), startAt, endAt };
	}

	/**
	 * Clone a session into a new bingo day.
	 * @param {object} opts
	 * @param {number} opts.sourceId
	 * @param {string} [opts.name]      default: "<source name> <date>"
	 * @param {string} [opts.date]      YYYY-MM-DD; default today
	 * @param {string} [opts.time]      HH:MM; default the source's start time
	 * @param {number} [opts.createdBy] employees.Id; default the source's creator
	 * @param {number} [opts.tzOffset]  the person's getTimezoneOffset(); default the database's zone
	 */
	function cloneSession( { sourceId, name, date, time, createdBy, tzOffset } ) {
		const src = requireSession( sourceId );
		const { start, end, startAt, endAt } = scheduleFrom( src, date, time, tzOffset );
		const sessionName = ( name && String( name ).trim() )
			|| `${src.SessionName} ${sqlDateTime( start ).slice( 0, 10 )}`;

		return transaction( () => {
			const newId = insert( "game_sessions", copyOf( "game_sessions", src, new Set( [ "slug" ] ), {
				SessionName:        sessionName.slice( 0, 50 ),
				SessionDateTime:    start,
				SessionEndDateTime: end,
				ParentSessionId:    Number( src.Id ),
				CreatedBy:          Number( createdBy ) || Number( src.CreatedBy ) || 0,
				Status:             STATUS.ACTIVE,
				isClonable:         0,
				bank_relation_id:   null,
				slug:               null,
			} ) );

			// games, remembering old -> new so per-game rules can follow.  One
			// multi-row insert, then read the new ids back: an auto-increment
			// hands them out in VALUES order, so position is the mapping.
			const gameMap = new Map();
			const games = rows( "SELECT * FROM games WHERE GameSessionId=? AND deleted_at IS NULL ORDER BY GameOrder, Id", Number( src.Id ) );
			insertMany( "games", games.map( g => copyOf( "games", g, new Set( [ "GameSessionId" ] ),
				{ GameSessionId: newId, ...GAME_RESET } ) ) );
			const newIds = rows( "SELECT Id FROM games WHERE GameSessionId=? ORDER BY Id", newId );
			if( newIds.length !== games.length )
				throw new Error( `cloned ${newIds.length} of ${games.length} games` );
			games.forEach( ( g, i ) => gameMap.set( Number( g.Id ), Number( newIds[ i ].Id ) ) );

			// which packs may play in which game
			const spt = rows( "SELECT * FROM session_package_types WHERE GameSessionId=? AND deleted_at IS NULL", Number( src.Id ) );
			const rules = [];
			for( const p of spt ) {
				const oldGame = Number( p.GameId ) || 0;
				const newGame = oldGame ? gameMap.get( oldGame ) : 0;
				if( oldGame && !newGame ) continue;     // rule for a game that no longer exists
				rules.push( copyOf( "session_package_types", p,
					new Set( [ "GameSessionId", "GameId" ] ), { GameSessionId: newId, GameId: newGame || p.GameId } ) );
			}
			const packageTypes = insertMany( "session_package_types", rules );

			// other per-session configuration; a missing table is skipped
			const extras = {};
			for( const { table, sessionCol } of cloneTables ) {
				if( !schema[ table ] ) continue;
				let list;
				try { list = rows( `SELECT * FROM \`${table}\` WHERE \`${sessionCol}\`=? AND deleted_at IS NULL`, Number( src.Id ) ); }
				catch( err ) { log( `clone: skipping ${table}: ${err.message}` ); continue; }
				const n = insertMany( table, list.map( r => copyOf( table, r, new Set( [ sessionCol ] ), { [ sessionCol ]: newId } ) ) );
				if( n ) extras[ table ] = n;
			}

			// NoOfGames is what the legacy UI shows; keep it honest
			db.do( "UPDATE game_sessions SET NoOfGames=? WHERE Id=?", gameMap.size, newId );

			log( `cloned session ${src.Id} "${src.SessionName}" -> ${newId} "${sessionName}"`
			   + ` (${gameMap.size} games, ${packageTypes} pack rules)` );
			return { id: newId, name: sessionName, games: gameMap.size, packageTypes, extras,
			         startAt: startAt.toISOString(), endAt: endAt.toISOString() };
		} );
	}

	/** Rename and/or reschedule; blank fields keep their value; the duration is kept. */
	function updateSession( { id, name, date, time, tzOffset } ) {
		const s = requireSession( id );
		const sets = [], args = [];
		if( name && String( name ).trim() ) { sets.push( "SessionName=?" ); args.push( String( name ).trim().slice( 0, 50 ) ); }
		if( date || time ) {
			const { start, end } = scheduleFrom( s, date, time, tzOffset );
			sets.push( "SessionDateTime=?", "SessionEndDateTime=?" );
			args.push( sqlDateTime( start ), sqlDateTime( end ) );
		}
		if( !sets.length ) return { id: Number( s.Id ), changed: false };
		db.do( `UPDATE game_sessions SET ${sets.join( ", " )} WHERE Id=?`, ...args, Number( s.Id ) );
		return { id: Number( s.Id ), changed: true };
	}

	function setStatus( { id, status } ) {
		const s = requireSession( id );
		const to = statusId( status );
		if( to === null ) throw new Error( `unknown status '${status}'` );
		if( to === STATUS.DELETED ) return deleteSession( { id } );
		db.do( "UPDATE game_sessions SET Status=? WHERE Id=?", to, Number( s.Id ) );
		return { id: Number( s.Id ), status: statusName( to ), statusId: to };
	}

	function setClonable( { id, clonable } ) {
		const s = requireSession( id );
		const flag = clonable ? 1 : 0;
		db.do( "UPDATE game_sessions SET isClonable=? WHERE Id=?", flag, Number( s.Id ) );
		return { id: Number( s.Id ), template: !!flag };
	}

	/** Soft delete.  A live session is refused; take it off the floor first. */
	function deleteSession( { id } ) {
		const s = requireSession( id );
		if( Number( s.Status ) === STATUS.LIVE ) throw new Error( "session is live" );
		return transaction( () => {
			db.do( "UPDATE game_rooms SET SessionId=NULL WHERE SessionId=?", Number( s.Id ) );
			db.do( "UPDATE game_sessions SET Status=?, deleted_at=? WHERE Id=?",
				STATUS.DELETED, sqlDateTime( dbNow() ), Number( s.Id ) );
			return { id: Number( s.Id ), deleted: true };
		} );
	}

	/**
	 * Put a session in a room.  game_rooms.SessionId is UNIQUE, so the session
	 * leaves whatever room it was in; the room drops whatever it was running.
	 */
	function assignRoom( { id, roomId } ) {
		const s = requireSession( id );
		const room = one( "SELECT Id, Name FROM game_rooms WHERE Id=? AND deleted_at IS NULL", Number( roomId ) );
		if( !room ) throw new Error( `no room ${roomId}` );
		return transaction( () => {
			db.do( "UPDATE game_rooms SET SessionId=NULL WHERE SessionId=?", Number( s.Id ) );
			db.do( "UPDATE game_rooms SET SessionId=? WHERE Id=?", Number( s.Id ), Number( room.Id ) );
			return { id: Number( s.Id ), roomId: Number( room.Id ), room: room.Name };
		} );
	}

	function clearRoom( { id } ) {
		const s = requireSession( id );
		db.do( "UPDATE game_rooms SET SessionId=NULL WHERE SessionId=?", Number( s.Id ) );
		return { id: Number( s.Id ), room: null };
	}

	return { dbNow, dbOffsetMs, instantOf, wallIn, isoOf,
	         statuses, statusId, getSession, listSessions, listGames, setGamePattern,
	         gameDetails, updateGame, listRooms,
	         cloneSession, updateSession, setStatus, setClonable, deleteSession,
	         assignRoom, clearRoom, STATUS };
}
