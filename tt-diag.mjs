/** Read the stored document and try to revive it, the way the server would. */
import sack from "sack.vfs";
import { JSOX } from "jsox";
// Importing the model registers Canvas/Page/Control with JSOX, exactly as the
// client does before it parses; without this the revival has no classes.
import { parse } from "./ui/core/document.js";
import { registerControl } from "./ui/core/registry.js";
for( const name of [ "Button", "Text Label", "Session", "data/Table" ] )
	registerControl( name, { properties: {}, create() {} } );

const db = new sack.DB( "tessera-trellis.db" );
const rows = db.do( `select id, name, length(snapshot) as len, snapshot_seq, modified from documents` );
console.log( "documents:", JSON.stringify( rows, null, 1 ) );

for( const row of rows ) {
	const [ doc ] = db.do( `select snapshot from documents where id=${row.id}` );
	const text = doc && doc.snapshot;
	console.log( `\n=== ${row.name} (${text ? text.length : 0} bytes) ===` );
	if( !text ) { console.log( "  EMPTY SNAPSHOT" ); continue; }
	console.log( "  head:", text.slice( 0, 240 ) );
	try {
		const canvas = parse( text );
		console.log( "  parsed ok. class:", canvas && canvas.constructor && canvas.constructor.name );
		console.log( "  pages:", canvas.pages && canvas.pages.length,
			"shared controls:", canvas.shared && canvas.shared.controls
				&& canvas.shared.controls.length );
	} catch( err ) {
		console.log( "  PARSE FAILED:", err.message );
		const m = /position (\d+)/.exec( err.message );
		if( m ) console.log( "  near:", JSON.stringify(
			text.slice( Math.max( 0, m[ 1 ] - 120 ), Number( m[ 1 ] ) + 120 ) ) );
	}
}
