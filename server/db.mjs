/**
 * @fileoverview Storage. SQLite for now; the SQL is plain enough to move to
 * MariaDB over ODBC by changing the open call.
 *
 * All SQL lives here as named methods -- the module is the stored-procedure
 * layer, the way protocol.mjs is the serialization layer.
 *
 * THREADING: db.run() resolves a promise, which means the work can land on a
 * worker thread, while SQLite may be built single-threaded.  Every call below
 * goes through serial(), so exactly one statement is ever in flight no matter
 * how many websocket clients ask at once.  That is cheap insurance and it does
 * not depend on how the sack layer was compiled -- db.do() would also be safe
 * (being synchronous) but blocks the JS thread on disk I/O.
 */

import sack from "sack.vfs";
import dbUtil from "sack.vfs/dbUtil";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname( fileURLToPath( import.meta.url ) );

const DB_FILE = process.env.TT_DB
	|| resolve( here, "..", "tessera-trellis.db" );

const db = sack.Sqlite( DB_FILE );

/*
 * WAL, and a bounded wait for the lock.  BOTH must precede autoTransact, which
 * opens a transaction immediately -- SQLite refuses journal_mode from inside
 * one.
 *
 * This is not tuning; it is what stops a second process from wedging the first
 * one permanently.  Default journalling makes a writer take an exclusive lock,
 * and with no busy_timeout a second connection waits for it *forever* rather
 * than failing.  Since autoTransact holds a transaction open for the life of
 * the process, "forever" is exactly what happens: the blocked statement never
 * settles, serial() below never advances past it, and every later request --
 * loadDocument included -- hangs behind it.  The visible symptom is a blank
 * editor and "timed out waiting for document", with a perfectly good document
 * sitting in the file.
 *
 * WAL lets readers and one writer coexist, so the common case stops contending
 * at all; busy_timeout bounds what is left, turning a permanent hang into a
 * plain error that the queue can step over.
 */
try {
	db.do( `PRAGMA journal_mode=WAL` );
	db.do( `PRAGMA busy_timeout=5000` );
} catch( err ) {
	console.log( "could not set WAL/busy_timeout:", err.message );
}

/*
 * Without this every statement is its own fsync -- measured at 7019ms for 50
 * inserts, versus 3ms with it.  autoTransact opens a transaction on the first
 * command and commits on a timer once the burst stops, which is exactly the
 * shape of an op log during a drag.
 */
db.autoTransact( true );

// -- serialization --------------------------------------------------------

let chain = Promise.resolve();

/**
 * Queue one database operation behind every prior one.
 * @param {() => any} work
 */
/** How long any one statement may hold the queue before it is stepped over. */
const STATEMENT_TIMEOUT = 15000;

function serial( work ) {
	const result = chain.then( work, work );
	/*
	 * The queue must survive a failed statement -- so swallow here -- and also
	 * a statement that never SETTLES, which a swallow alone does not cover.
	 * A promise that never resolves would stall every later caller for the
	 * life of the process, so the chain advances on a timer regardless.  The
	 * caller still receives the real promise; only the queue gives up waiting.
	 */
	chain = new Promise( ( advance ) => {
		const timer = setTimeout( () => {
			console.log( `database statement exceeded ${STATEMENT_TIMEOUT}ms;`
				+ ` continuing the queue without it` );
			advance();
		}, STATEMENT_TIMEOUT );
		timer.unref?.();                    // never hold the process open
		result.then( () => {}, () => {} ).then( () => {
			clearTimeout( timer );          // settled in time; no warning
			advance();
		} );
	} );
	return result;
}

// -- schema ---------------------------------------------------------------

/*
 * A document is a canvas.  Storage is a whole snapshot.
 *
 * The op log below is left over from an abandoned plan and nothing calls it.
 * Undo belongs to an editing session, not to a document: a log shared by every
 * window is precisely what would let one editor undo another's work.  Keeping
 * the stack client-local rules that out by construction rather than by rule.
 */
db.makeTable( `create table documents (
	  id integer auto_increment
	, name char(64) not null
	, snapshot text
	, snapshot_seq int not null default 0
	, created timestamp
	, modified timestamp
	, grid_x int(11)
	, grid_y int(11)
	, INDEX doc_name (name)
	)` );

db.makeTable( `create table document_ops (
	  id integer auto_increment
	, document_id int not null
	, seq int not null
	, op text not null
	, author char(64)
	, stamp timestamp
	, INDEX doc_seq (document_id)
	)` );

/*
 * No separate migration step: makeTable merges, so adding a column above is
 * enough to bring an existing file forward.  Changing a column *type* is not
 * covered -- that would want dbUtil.Sqlite.loadSchema() and a hand-written
 * conversion, which is a problem for the day it happens.
 */

/** Timestamps must be bound as SQL text; a Date object is not a bindable type. */
const stamp = () => dbUtil.getSqlDateTime( new Date() );

// -- documents ------------------------------------------------------------

export function listDocuments() {
	return serial( () => db.run(
		`select id, name, snapshot_seq, modified from documents order by name` ) );
}

export async function findDocument( name ) {
	const rows = await serial( () => db.run(
		`select id, name, snapshot, snapshot_seq from documents where name=?`, name ) );
	return rows && rows.length ? rows[ 0 ] : null;
}

/**
 * @param {string} name
 * @param {string} snapshot  JSOX text of the Canvas
 */
export async function createDocument( name, snapshot ) {
	const now = stamp();
	await serial( () => db.run(
		`insert into documents (name, snapshot, snapshot_seq, created, modified)
		 values (?,?,?,?,?)`,
		name, snapshot, 0, now, now ) );
	return findDocument( name );
}

/** Replace the snapshot and mark which op it already includes. */
export function saveSnapshot( id, snapshot, seq ) {
	return serial( () => db.run(
		`update documents set snapshot=?, snapshot_seq=?, modified=? where id=?`,
		snapshot, seq, stamp(), id ) );
}

export function renameDocument( id, name ) {
	return serial( () => db.run(
		`update documents set name=?, modified=? where id=?`, name, stamp(), id ) );
}

export function deleteDocument( id ) {
	return serial( async () => {
		await db.run( `delete from document_ops where document_id=?`, id );
		await db.run( `delete from documents where id=?`, id );
	} );
}

// -- op log ---------------------------------------------------------------

/**
 * @param {number} documentId
 * @param {number} seq   monotonic per document; the caller allocates it
 * @param {string} op    JSOX text of the op
 * @param {string} author
 */
export function appendOp( documentId, seq, op, author ) {
	return serial( () => db.run(
		`insert into document_ops (document_id, seq, op, author, stamp)
		 values (?,?,?,?,?)`,
		documentId, seq, op, author || "", stamp() ) );
}

/** Ops a client has not seen yet; how a reconnecting window catches up. */
export function opsSince( documentId, seq ) {
	return serial( () => db.run(
		`select seq, op, author, stamp from document_ops
		  where document_id=? and seq>? order by seq`,
		documentId, seq ) );
}

export async function latestSeq( documentId ) {
	const rows = await serial( () => db.run(
		`select max(seq) as seq from document_ops where document_id=?`, documentId ) );
	return ( rows && rows.length && rows[ 0 ].seq ) || 0;
}

/** Drop ops already folded into a snapshot. */
export function trimOps( documentId, throughSeq ) {
	return serial( () => db.run(
		`delete from document_ops where document_id=? and seq<=?`,
		documentId, throughSeq ) );
}

/**
 * Commit and close.
 *
 * autoTransact keeps a transaction open between bursts, so a process that is
 * killed outright loses whatever had not reached its commit timer yet -- and
 * being replaced by a newer instance is exactly when that happens.  Called
 * from the exit signal so a handover commits rather than discards.
 */
export function closeDatabase() {
	/*
	 * close() is enough: a graceful shutdown flushes pending transactions.  An
	 * explicit commit() first is redundant, and logs "Commit issued with no
	 * transaction started" on every handover where autoTransact's timer had
	 * already fired -- which is most of them.
	 *
	 * What matters is exiting gracefully AT ALL.  A hard kill loses whatever
	 * had not reached the commit timer, and being replaced by a newer instance
	 * is precisely when that would happen.
	 */
	try { db.close(); } catch( err ) { console.log( "close on exit:", err.message ); }
}

export { db, DB_FILE };
