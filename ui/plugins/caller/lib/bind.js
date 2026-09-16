/**
 * @fileoverview What every caller control does the same way.
 *
 * A control's element carries a small box of subscriptions to the caller
 * state; `whenReady` runs once the connection module has loaded (or at once
 * if it already has), and `detach` releases everything in dispose().  A
 * control that was disposed before the connection came up simply never
 * subscribes, which is why the box is checked after the await.
 */

import { ready } from "./connection.js";

export function attach( el ) {
	const box = { subs: [], disposed: false };
	el._ttc = box;
	return box;
}

/**
 * @param {HTMLElement} el
 * @param {( ctx:{state:object, modules:object, caller:object}, box:object ) => void} fn
 */
export function whenReady( el, fn ) {
	const box = el._ttc || attach( el );
	ready().then( ctx => { if( !box.disposed ) fn( ctx, box ); } )
		.catch( err => console.error( "caller control:", err ) );
}

/** subscribe to a state event for the life of the element */
export function listen( box, state, name, fn ) {
	box.subs.push( state.on( name, fn ) );
}

export function detach( el ) {
	const box = el._ttc;
	if( !box ) return;
	box.disposed = true;
	for( const off of box.subs ) off();
	box.subs.length = 0;
}

/** ask the page to show another page, the way a button's nextPage does */
export function navigate( el, page ) {
	if( !page ) return;
	el.dispatchEvent( new CustomEvent( "tt-navigate", { bubbles: true, detail: { page } } ) );
}

/** a game's card size (rows) from its "5x5"-style size, default 5 */
export function gameSize( game ) {
	const n = game && game.size !== undefined ? Number( String( game.size )[ 0 ] ) : 0;
	return n || 5;
}

/** a game's pattern masks, expanded if the Pattern class is behind it */
export function gameMasks( game ) {
	const pattern = game && game.pattern;
	if( !pattern ) return [ 0x1FFFFFF ];
	if( typeof pattern.Expand === "function" ) { try { pattern.Expand(); } catch( err ) { /* leave as sent */ } }
	return ( pattern.composite_masks && pattern.composite_masks.length ) ? pattern.composite_masks : [ 0x1FFFFFF ];
}
