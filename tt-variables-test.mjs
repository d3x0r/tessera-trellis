/**
 * Cases for %variable substitution and the watch/notify path.
 *
 * The interesting half is late binding: a text may mention a variable that
 * does not exist yet, and with no delimiter in the spelling there is no way to
 * find that name by parsing -- '%Station/panel' is undecidable between
 * "Station" and "Station/panel" until the registry says which is real.  So
 * defineVariable() re-scans the live watches, and this is where that is held.
 */
import { defineVariable, setVariable, expand, referencedBy, watch }
	from "./ui/core/variables.js";

let pass = 0, fail = 0;

function ok( label, got, want ) {
	if( got === want ) { pass++; console.log( `  ok   ${label} -> ${JSON.stringify( got )}` ); }
	else { fail++; console.log( `  FAIL ${label} -> ${JSON.stringify( got )} (wanted ${JSON.stringify( want )})` ); }
}

console.log( "-- a variable is a whole name, or part of one --" );
defineVariable( "Kiosk URL", "http://dash.local/panel" );
defineVariable( "Station", "till-4" );
ok( "whole",  expand( "%Kiosk URL" ), "http://dash.local/panel" );
ok( "prefix", expand( "https://%Station/status" ), "https://till-4/status" );
ok( "twice",  expand( "%Station-%Station" ), "till-4-till-4" );
ok( "query",  expand( "http://h/p?s=%Station&x=1" ), "http://h/p?s=till-4&x=1" );

console.log( "-- longest defined name wins at each '%' --" );
defineVariable( "Host", "box" );
defineVariable( "Host Mode Select", "Standalone" );
ok( "long",  expand( "%Host Mode Select" ), "Standalone" );
ok( "short", expand( "%Host/x" ), "box/x" );

console.log( "-- '%%' is a literal percent, and percent-encoding survives --" );
ok( "escape",  expand( "100%%" ), "100%" );
ok( "encoded", expand( "http://h/a%20b" ), "http://h/a%20b" );

console.log( "-- an undefined name leaves its '%' alone --" );
ok( "unknown", expand( "%Nothing Defined/x" ), "%Nothing Defined/x" );
ok( "refs",    referencedBy( "%Nothing Defined" ).length, 0 );

console.log( "-- watch fires when a referenced variable changes --" );
{
	let fired = 0;
	const off = watch( "port %Watched One", () => fired++ );
	defineVariable( "Watched One", "a" );          // defined late: must bind
	ok( "late define notified", fired, 1 );
	setVariable( "Watched One", "b" );
	ok( "change notified", fired, 2 );
	setVariable( "Watched One", "b" );             // same value: no notify
	ok( "unchanged is quiet", fired, 2 );
	off();
	setVariable( "Watched One", "c" );
	ok( "unsubscribed", fired, 2 );
}

console.log( "-- a late unsubscribe does not leave the watch behind --" );
{
	let fired = 0;
	const off = watch( "%Never Bound", () => fired++ );
	off();                                          // before the name exists
	defineVariable( "Never Bound", "x" );
	ok( "dropped before binding", fired, 0 );
}

console.log( "-- a longer name appearing re-resolves an existing watch --" );
{
	let fired = 0;
	defineVariable( "Till", "T1" );
	const off = watch( "%Till Group", () => fired++ );   // matches "Till" for now
	ok( "bound to the short name", referencedBy( "%Till Group" )[ 0 ], "Till" );

	defineVariable( "Till Group", "north" );             // now the longer wins
	ok( "re-resolved", referencedBy( "%Till Group" )[ 0 ], "Till Group" );
	ok( "notified on rebind", fired, 1 );

	setVariable( "Till", "T2" );                        // no longer referenced
	ok( "stale name detached", fired, 1 );
	setVariable( "Till Group", "south" );
	ok( "new name attached", fired, 2 );
	off();
}

console.log( "-- a PROC variable re-evaluates on every expansion --" );
{
	let n = 0;
	defineVariable( "Counter", () => ++n );
	ok( "first",  expand( "%Counter" ), "1" );
	ok( "second", expand( "%Counter" ), "2" );
}

console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
