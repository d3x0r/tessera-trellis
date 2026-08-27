/**
 * Idle watcher, with a fake DOM just large enough for it: listeners plus a
 * controllable clock, so a four-hour timeout can be tested in milliseconds.
 */
const listeners = new Map();
const on = ( t, fn ) => { if( !listeners.has( t ) ) listeners.set( t, new Set() ); listeners.get( t ).add( fn ); };
const off = ( t, fn ) => listeners.has( t ) && listeners.get( t ).delete( fn );
const fire = ( t ) => { for( const fn of listeners.get( t ) || [] ) fn( {} ); };

globalThis.window = { addEventListener: on, removeEventListener: off };
globalThis.document = { addEventListener: on, removeEventListener: off };

let now = 1_000_000;
const realNow = Date.now;
Date.now = () => now;
const advance = ( ms ) => { now += ms; };

const { watchIdle } = await import( "./ui/core/idle.js" );

let pass = 0, fail = 0;
const check = ( name, cond, extra ) => cond
	? ( pass++, console.log( "  ok   " + name ) )
	: ( fail++, console.log( "  FAIL " + name, extra === undefined ? "" : extra ) );

const MIN = 60_000;

// A long timeout, exercised by moving the clock rather than waiting for it.
{
	const seen = [];
	const w = watchIdle( { minutes: 240, pollMs: 5,
		onIdle: ( r ) => seen.push( "idle:" + r ), onWake: () => seen.push( "wake" ) } );

	advance( 3 * 60 * MIN );
	await new Promise( r => setTimeout( r, 20 ) );          // let the poll run
	check( "not idle 3h into a 4h timeout", !w.idle && !seen.length, seen );

	advance( 90 * MIN );                                     // now past 4h
	await new Promise( r => setTimeout( r, 20 ) );
	check( "idle once the timeout is crossed", w.idle && seen[ 0 ] === "idle:timeout", seen );

	fire( "pointerdown" );
	check( "input wakes it and resets the clock",
		!w.idle && w.sinceActivity === 0 && seen[ 1 ] === "wake", seen );

	advance( 5 * 60 * MIN );                                 // long past it again
	await new Promise( r => setTimeout( r, 20 ) );
	check( "it can go idle a second time", w.idle && seen[ 2 ] === "idle:timeout", seen );
	w.stop();
}

// a stopped watcher never fires again
{
	const seen = [];
	const w = watchIdle( { minutes: 1, pollMs: 5, onIdle: () => seen.push( "idle" ) } );
	w.stop();
	advance( 10 * MIN );
	await new Promise( r => setTimeout( r, 20 ) );
	check( "stop() halts the poll", seen.length === 0, seen );
}

// trigger(): on demand, regardless of the timer
{
	const seen = [];
	const w = watchIdle( { minutes: 0,
		onIdle: ( r ) => seen.push( "idle:" + r ), onWake: () => seen.push( "wake" ) } );
	check( "a 0 timeout does not idle on its own", !w.idle );
	w.trigger();
	check( "trigger() goes idle", w.idle && seen[ 0 ] === "idle:requested", seen );
	w.trigger();
	check( "trigger() is idempotent while idle", seen.length === 1, seen );
	fire( "keydown" );
	check( "input wakes it", !w.idle && seen[ 1 ] === "wake", seen );
	w.stop();
}

// relayed activity from a framed client
{
	const seen = [];
	const w = watchIdle( { minutes: 60,
		onIdle: () => seen.push( "idle" ), onWake: () => seen.push( "wake" ) } );
	w.trigger();
	fire( "tt-activity" );
	check( "tt-activity wakes the shell", !w.idle && seen.includes( "wake" ), seen );
	w.stop();
}

// an explicit screensaver request from a framed client
{
	const seen = [];
	const w = watchIdle( { minutes: 0, onIdle: ( r ) => seen.push( r ) } );
	fire( "tt-screensaver" );
	check( "tt-screensaver blanks on demand", w.idle && seen[ 0 ] === "requested", seen );
	w.stop();
}

// stop() detaches
{
	const w = watchIdle( { minutes: 60, onIdle: () => {} } );
	w.stop();
	const before = w.sinceActivity;
	advance( 1000 );
	fire( "pointerdown" );
	check( "stop() detaches local listeners", w.sinceActivity > before );
}

Date.now = realNow;
console.log( `\n${pass} passed, ${fail} failed` );
process.exit( fail ? 1 : 0 );
