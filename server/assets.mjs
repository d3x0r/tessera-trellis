/**
 * @fileoverview Uploaded images.
 *
 * Kept in ui/uploads/ rather than ui/images/ so user uploads never mix with the
 * art that ships with the service -- a redeploy must not be able to clobber
 * something a document depends on, and "which of these can I delete" has to
 * have an answer.
 *
 * Both directories are inside the served resource path, so an upload is
 * reachable at its URL the moment it lands; nothing has to proxy it.
 */

import { readdirSync, writeFileSync, existsSync, statSync, unlinkSync } from "node:fs";
import { resolve, dirname, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname( fileURLToPath( import.meta.url ) );
const root = resolve( here, ".." );

const UPLOADS = resolve( root, "ui", "uploads" );
const BUILTIN = resolve( root, "ui", "images" );

/** Anything a browser will actually render as an image. */
const ALLOWED = new Set( [ ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif" ] );

/*
 * Upload cap.  16MB by default -- an unoptimised camera JPEG used as a page
 * background lands around 12MB, and refusing that is more annoying than
 * storing it.  Override with TT_MAX_IMAGE (bytes) for a deployment that wants
 * a tighter or looser bound.
 *
 * The client is told this value rather than carrying its own copy, so the two
 * cannot drift and a rejection never comes as a surprise after the upload.
 */
const MAX_BYTES = Number( process.env.TT_MAX_IMAGE ) || 16 * 1024 * 1024;

/**
 * Reduce a client-supplied name to a bare filename.
 *
 * The client controls this string, so it is treated as hostile: basename()
 * strips any directory part, and the remaining characters are filtered so
 * nothing can escape the uploads directory or collide with a dotfile.
 *
 * @param {string} name
 * @returns {string|null} null when nothing usable survives
 */
export function safeName( name ) {
	const bare = basename( String( name || "" ) ).replace( /[^\w.\- ]+/g, "_" ).trim();
	if( !bare || bare.startsWith( "." ) ) return null;
	const ext = extname( bare ).toLowerCase();
	if( !ALLOWED.has( ext ) ) return null;
	return bare;
}

/** A name not already taken, so an upload never silently replaces another. */
function uniqueName( name ) {
	const ext = extname( name );
	const stem = name.slice( 0, -ext.length );
	let candidate = name, n = 1;
	while( existsSync( resolve( UPLOADS, candidate ) ) )
		candidate = `${stem}-${++n}${ext}`;
	return candidate;
}

/**
 * @param {string} name
 * @param {Uint8Array|ArrayBuffer} data
 * @returns {{ok:boolean, url?:string, name?:string, error?:string}}
 */
export function putImage( name, data ) {
	const clean = safeName( name );
	if( !clean ) return { ok: false, error: "unsupported file name or type" };

	const bytes = data instanceof Uint8Array ? data : new Uint8Array( data || [] );
	if( !bytes.length ) return { ok: false, error: "empty file" };
	if( bytes.length > MAX_BYTES )
		return { ok: false, error: `too large (max ${describeLimit()})` };

	const final = uniqueName( clean );
	writeFileSync( resolve( UPLOADS, final ), bytes );
	console.log( `stored image ${final} (${bytes.length} bytes)` );
	return { ok: true, name: final, url: "uploads/" + final };
}

export function describeLimit() {
	return ( MAX_BYTES / 1024 / 1024 ).toFixed( MAX_BYTES % ( 1024 * 1024 ) ? 1 : 0 ) + "MB";
}

/** What the client needs to validate before sending anything. */
export function limits() {
	return { maxBytes: MAX_BYTES, maxLabel: describeLimit(),
	         extensions: [ ...ALLOWED ] };
}

/** Everything a document can point at: shipped art plus uploads. */
export function listImages() {
	const scan = ( dir, prefix ) => {
		if( !existsSync( dir ) ) return [];
		return readdirSync( dir )
			.filter( f => ALLOWED.has( extname( f ).toLowerCase() ) )
			.map( f => ( { url: prefix + f, name: f,
			               bytes: statSync( resolve( dir, f ) ).size,
			               builtin: prefix === "images/" } ) );
	};
	return scan( BUILTIN, "images/" ).concat( scan( UPLOADS, "uploads/" ) )
		.sort( ( a, b ) => a.url.localeCompare( b.url ) );
}

/** Only uploads may be removed; shipped art is not the document's to delete. */
export function removeImage( url ) {
	if( typeof url !== "string" || !url.startsWith( "uploads/" ) )
		return { ok: false, error: "only uploaded images can be removed" };
	const clean = safeName( url.slice( "uploads/".length ) );
	if( !clean ) return { ok: false, error: "bad name" };
	const path = resolve( UPLOADS, clean );
	if( !existsSync( path ) ) return { ok: false, error: "no such image" };
	unlinkSync( path );
	return { ok: true };
}

export { UPLOADS, BUILTIN };
