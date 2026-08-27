/** Screen-saver page selection and rotation, against the real document model. */
import { Canvas, Page } from "./ui/core/document.js";

let pass = 0, fail = 0;
const check = ( n, c, x ) => c ? ( pass++, console.log( "  ok   " + n ) )
                               : ( fail++, console.log( "  FAIL " + n, x === undefined ? "" : x ) );

const canvas = new Canvas( "T" );
const main = canvas.addPage( new Page( "Main" ) );
const a = canvas.addPage( new Page( "Attract A" ) );
const b = canvas.addPage( new Page( "Attract B" ) );
const c = canvas.addPage( new Page( "Attract C" ) );

check( "no screensaver pages by default", canvas.screensaverPages().length === 0 );
check( "screensaverPage() is null when none", canvas.screensaverPage() === null );

a.screensaver = true; a.screensaverSeconds = 10;
b.screensaver = true; b.screensaverSeconds = 5;
check( "two marked pages are both returned", canvas.screensaverPages().length === 2 );
check( "loop order follows page order",
	canvas.screensaverPages().map( p => p.title ).join( "," ) === "Attract A,Attract B",
	canvas.screensaverPages().map( p => p.title ) );
check( "screensaverPage() is the first", canvas.screensaverPage() === a );

// A destroyed page drops out of the loop.
b.deleted = true;
check( "destroyed pages leave the loop", canvas.screensaverPages().length === 1 );
b.deleted = false;

// Marking a third does NOT unmark the others -- the loop is the point.
c.screensaver = true;
check( "marking another keeps the rest", canvas.screensaverPages().length === 3 );

/* The stepping rule, as index.js applies it. */
function nextDelay( pages, page ) {
	const seconds = Number( page.screensaverSeconds ) || 0;
	if( pages.length < 2 || seconds <= 0 ) return null;   // hold here
	return seconds * 1000;
}

const pages = canvas.screensaverPages();
check( "a page with a duration advances", nextDelay( pages, a ) === 10000 );
check( "a 0-second page holds", nextDelay( pages, c ) === null, c.screensaverSeconds );
check( "a lone page holds even with a duration", nextDelay( [ a ], a ) === null );

// Order of the walk, honouring each page's own hold.
const walk = [];
let i = 0;
for( let step = 0; step < 5; step++ ) {
	const p = pages[ i % pages.length ];
	walk.push( p.title );
	if( nextDelay( pages, p ) === null ) break;
	i++;
}
check( "walk stops at the first holding page",
	walk.join( "," ) === "Attract A,Attract B,Attract C", walk );

// -- symbolic page targets ----------------------------------------------
{
	const live = canvas.livePages();          // Main, Attract A, Attract B, Attract C
	check( "(first) is the first live page", canvas.resolvePage( "(first)", c ) === main );
	check( "(next) steps forward", canvas.resolvePage( "(next)", main ) === a );
	check( "(next) wraps at the end", canvas.resolvePage( "(next)", c ) === main, live.length );
	check( "(previous) steps back", canvas.resolvePage( "(previous)", a ) === main );
	check( "(previous) wraps at the start", canvas.resolvePage( "(previous)", main ) === c );
	check( "a plain title still resolves", canvas.resolvePage( "Attract B", main ) === b );
	check( "an unknown title is null", canvas.resolvePage( "Nope", main ) === null );
	check( "empty is null", canvas.resolvePage( "", main ) === null );
	check( "tokens are case-insensitive", canvas.resolvePage( "(NEXT)", main ) === a );

	// The attract loop steps within the screensaver pages only.
	check( "(next screensaver) stays in the loop",
		canvas.resolvePage( "(next screensaver)", a ) === b );
	check( "(next screensaver) wraps within the loop",
		canvas.resolvePage( "(next screensaver)", c ) === a );
	// From a page outside the loop it enters at the beginning.
	check( "(next screensaver) from outside enters at the start",
		canvas.resolvePage( "(next screensaver)", main ) === a );

	// A destroyed page drops out of stepping.
	b.deleted = true;
	check( "(next) skips destroyed pages", canvas.resolvePage( "(next)", a ) === c );
	b.deleted = false;
}

// -- reordering pages ----------------------------------------------------
{
	const k = new Canvas( "R" );
	const p1 = k.addPage( new Page( "One" ) );
	const p2 = k.addPage( new Page( "Two" ) );
	const p3 = k.addPage( new Page( "Three" ) );
	const order = () => k.livePages().map( p => p.title ).join( "," );

	check( "starts in insertion order", order() === "One,Two,Three", order() );
	check( "move later reports movement", k.movePage( p1, 1 ) === true );
	check( "moved later", order() === "Two,One,Three", order() );
	check( "move earlier", k.movePage( p1, -1 ) && order() === "One,Two,Three", order() );

	check( "cannot move the first earlier", k.movePage( p1, -1 ) === false );
	check( "cannot move the last later", k.movePage( p3, 1 ) === false );
	check( "order unchanged by refused moves", order() === "One,Two,Three", order() );

	/*
	 * A destroyed page between two live ones keeps its slot: the swap happens
	 * in the full array while the neighbour comes from the live ones.
	 */
	p2.deleted = true;
	check( "live order skips the destroyed page", order() === "One,Three", order() );
	k.movePage( p3, -1 );
	check( "live pages swap around it", order() === "Three,One", order() );
	p2.deleted = false;
	check( "the destroyed page returns to its own slot",
		k.livePages().map( p => p.title ).join( "," ) === "Three,Two,One",
		k.livePages().map( p => p.title ) );

	// Identity must survive: undo restores a sequence, never copies.
	const snapshot = k.pages.slice();
	k.movePage( k.livePages()[ 0 ], 1 );
	k.pages = snapshot.slice();
	check( "restoring the order keeps the same Page objects",
		k.pages.every( p => [ p1, p2, p3 ].includes( p ) ) && k.pages.length === 3 );
}

// Serialization keeps both fields.
import( "./ui/core/document.js" ).then( async ( m ) => {
	const round = m.parse( m.stringify( canvas ) );
	const rp = round.screensaverPages();
	check( "screensaver flags survive a round trip", rp.length === 3, rp.length );
	check( "durations survive a round trip",
		rp[ 0 ].screensaverSeconds === 10 && rp[ 1 ].screensaverSeconds === 5,
		rp.map( p => p.screensaverSeconds ) );
	check( "idle config survives", round.idle && round.idle.minutes === 0, round.idle );

	console.log( `\n${pass} passed, ${fail} failed` );
	process.exit( fail ? 1 : 0 );
} );
