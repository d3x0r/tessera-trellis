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
	if( !existing ) reindex();
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

/**
 * Call cb whenever any variable referenced by text changes.
 * @returns {Function} unsubscribe
 */
export function watch( text, cb ) {
	const names = referencedBy( text );
	for( const name of names ) vars.get( name ).subs.add( cb );
	return () => {
		for( const name of names ) {
			const v = vars.get( name );
			if( v ) v.subs.delete( cb );
		}
	};
}
