/**
 * @fileoverview Press-time input.
 *
 * A button sends "control X was pressed" plus whatever the user supplied at
 * press time; the server validates that against the action's input schema.
 * This module is where "whatever the user supplied" is collected.
 *
 * Controls that PRODUCE input -- a Field, a Table row selection -- publish a
 * named value here.  Controls that CONSUME it -- a Button, a Table whose source
 * takes runtime filters -- call gatherInputs() and send the lot; the server
 * keeps only the keys the action or source declares, so over-sending is
 * harmless and the document author never wires a field to a button by hand.
 *
 * One namespace per window.  A document is one application and one view, so
 * a name means the same thing on every page of it: a session picked on the
 * "Sessions" page is still the selected session on the "Games" page.  That is
 * the property that makes a two-page workflow possible without a variable
 * system for it.  Per-page scoping can be added later by keying on a page
 * element; nothing here assumes a global beyond this map.
 */

/** @type {Map<string, any>} */
const values = new Map();

/** @type {Set<(name:string, value:any)=>void>} */
const listeners = new Set();

/**
 * @param {string} name
 * @param {any} value   undefined clears the entry
 */
export function setInput( name, value ) {
	if( !name ) return;
	if( value === undefined ) values.delete( name );
	else values.set( name, value );
	for( const cb of listeners ) {
		try { cb( name, value ); } catch( err ) { console.warn( "input listener failed:", err ); }
	}
}

export function clearInput( name ) { setInput( name, undefined ); }

export function getInput( name ) { return values.get( name ); }

/**
 * A plain copy of everything currently published, plus the browser's zone:
 * a typed date or time is wall-clock where the person sits, and the server
 * needs tzOffset (getTimezoneOffset(): minutes to add to local to reach UTC)
 * to turn it into an instant.  Declared in an action's input schema when it
 * matters; dropped by the server otherwise, like any undeclared key.
 */
export function gatherInputs() {
	return { tzOffset: new Date().getTimezoneOffset(), ...Object.fromEntries( values ) };
}

/** Be told when any input changes; returns an unsubscribe function. */
export function watchInputs( cb ) {
	listeners.add( cb );
	return () => listeners.delete( cb );
}

/*
 * Controls may also announce a value with a bubbling event, which keeps a
 * control module free of any import beyond the registry:
 *
 *   el.dispatchEvent( new CustomEvent( "tt-input",
 *       { bubbles: true, detail: { name: "sessionId", value: 42 } } ) );
 */
if( typeof document !== "undefined" )
	document.addEventListener( "tt-input", ( e ) => {
		const d = e.detail || {};
		setInput( d.name, d.value );
	} );
