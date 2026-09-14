/**
 * @fileoverview Label variables -- the reactive binding layer.
 *
 * The C version had CreateLabelVariable() with STRING / INT / PROC types and
 * LabelVariableChanged() to push updates.  Same idea, expressed as a small
 * signal store: a variable holds a value or a getter, and anything whose text
 * mentions it re-renders when it changes.
 *
 * Substitution keeps the original '%Name Of Variable' spelling -- no braces,
 * no delimiter -- by matching the longest defined name at each '%'.  '%%' is a
 * literal percent.
 */

/** @type {Map<string,{value:any, get:?Function, subs:Set<Function>}>} */
const vars = new Map();

/** Names sorted longest-first, so matching is greedy. Rebuilt on define. */
let byLength = [];

function reindex() {
	byLength = [ ...vars.keys() ].sort( ( a, b ) => b.length - a.length );
}

/**
 * @param {string} name
 * @param {any|Function} valueOrGetter  a plain value, or a getter re-invoked
 *                                      on every expansion (the PROC types).
 */
export function defineVariable( name, valueOrGetter ) {
	const existing = vars.get( name );
	const subs = existing ? existing.subs : new Set();
	const isProc = typeof valueOrGetter === "function";
	vars.set( name, { value: isProc ? undefined : valueOrGetter,
	                  get: isProc ? valueOrGetter : null, subs } );
	/*
	 * A new name can change what existing texts resolve to, so re-scan the
	 * live watches before notifying -- anything that now references this name
	 * is subscribed by then and hears about it through notify() below, rather
	 * than needing a second call here.
	 */
	if( !existing ) { reindex(); for( const entry of watches ) bind( entry ); }
	notify( name );
	return name;
}

export function setVariable( name, value ) {
	const v = vars.get( name );
	if( !v ) return defineVariable( name, value );
	if( v.value === value && !v.get ) return name;
	v.value = value;
	v.get = null;
	notify( name );
	return name;
}

export function getVariable( name ) {
	const v = vars.get( name );
	if( !v ) return undefined;
	return v.get ? v.get() : v.value;
}

export function variableNames() {
	return [ ...vars.keys() ].sort();
}

/** Re-evaluate a PROC variable and push it to watchers. */
export function invalidateVariable( name ) { notify( name ); }

function notify( name ) {
	const v = vars.get( name );
	if( !v ) return;
	for( const cb of v.subs ) cb( name );
}

/**
 * Which variables does this text reference?
 * @returns {string[]}
 */
export function referencedBy( text ) {
	const found = [];
	if( !text ) return found;
	for( let i = 0; i < text.length; i++ ) {
		if( text[ i ] !== "%" ) continue;
		if( text[ i + 1 ] === "%" ) { i++; continue; }
		for( const name of byLength ) {
			if( text.startsWith( name, i + 1 ) ) {
				if( !found.includes( name ) ) found.push( name );
				i += name.length;
				break;
			}
		}
	}
	return found;
}

/** Substitute every known variable reference in text. */
export function expand( text ) {
	if( !text ) return "";
	let out = "";
	for( let i = 0; i < text.length; i++ ) {
		if( text[ i ] !== "%" ) { out += text[ i ]; continue; }
		if( text[ i + 1 ] === "%" ) { out += "%"; i++; continue; }
		let matched = null;
		for( const name of byLength )
			if( text.startsWith( name, i + 1 ) ) { matched = name; break; }
		if( !matched ) { out += "%"; continue; }
		const value = getVariable( matched );
		out += value === undefined || value === null ? "" : String( value );
		i += matched.length;
	}
	return out;
}

/*
 * Every live watch, so a variable DEFINED LATER can still reach the text that
 * mentions it.
 *
 * referencedBy() can only find names that already exist -- with no delimiter,
 * '%Station/panel' is undecidable between "Station" and "Station/panel" until
 * the registry says which one is real -- so a text mentioning a variable that
 * does not exist yet subscribes to nothing, and defineVariable() has no way to
 * find it afterwards.  Keeping the watches lets a new name re-scan them.
 *
 * The rescan runs only when a NEW name appears, which is an application-load
 * event rather than anything on the update path.
 */
const watches = new Set();

/**
 * Reconcile one watch against the current registry.
 *
 * Names are dropped as well as added, because a longer name appearing changes
 * what an existing text resolves to: '%Host Mode Select' matches "Host" while
 * that is all there is, and must stop doing so once the full name is defined.
 */
function bind( entry ) {
	const want = new Set( referencedBy( entry.text ) );
	for( const name of entry.names ) {
		if( want.has( name ) ) continue;
		const v = vars.get( name );
		if( v ) v.subs.delete( entry.cb );
		entry.names.delete( name );
	}
	for( const name of want ) {
		if( entry.names.has( name ) ) continue;
		entry.names.add( name );
		vars.get( name ).subs.add( entry.cb );
	}
}

/**
 * Call cb whenever any variable referenced by text changes -- including one
 * defined after this call, which then notifies through the usual path.
 * @returns {Function} unsubscribe
 */
export function watch( text, cb ) {
	const entry = { text, cb, names: new Set() };
	bind( entry );
	watches.add( entry );
	return () => {
		watches.delete( entry );
		for( const name of entry.names ) {
			const v = vars.get( name );
			if( v ) v.subs.delete( cb );
		}
		entry.names.clear();
	};
}
