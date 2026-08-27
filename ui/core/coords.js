/**
 * @fileoverview Grid coordinate math.
 *
 * A page is a fixed 10000x10000 lattice.  One unit is 1/100th of a percent of
 * the page, so 10000 units is exactly 100.00% -- a coordinate converts to CSS
 * with no layout query at all, and the browser does the resolution math.
 *
 * The coarse grid the user edits against is a *snap divisor* only; it never
 * affects what gets stored.
 */

export const GRID = 10000;

/** Convert grid units to a CSS percentage string. */
export function toCss( units ) {
	return ( units / 100 ) + "%";
}

/** Clamp a grid coordinate into the page. */
export function clamp( v ) {
	return v < 0 ? 0 : v > GRID ? GRID : v;
}

/**
 * Snap a grid coordinate to the nearest cell edge of a coarse grid.
 * @param {number} v        grid units
 * @param {number} divisor  cells across the page; 0/falsy disables snapping
 */
export function snap( v, divisor ) {
	if( !divisor ) return Math.round( v );
	const step = GRID / divisor;
	return Math.round( Math.round( v / step ) * step );
}

/**
 * Pointer <-> grid conversion for one page element.
 *
 * The element rect is the *only* thing ever asked of the browser, and it is
 * cached until something invalidates it.  Everything downstream is integer
 * arithmetic against our own rect list.
 */
export class PageMetrics {
	#el;
	#rect = null;

	constructor( el ) {
		this.#el = el;
	}

	get element() { return this.#el; }

	invalidate() { this.#rect = null; }

	get rect() {
		return this.#rect || ( this.#rect = this.#el.getBoundingClientRect() );
	}

	/** Client pixel X -> grid units. */
	toGridX( clientX ) {
		const r = this.rect;
		return ( ( clientX - r.left ) / r.width ) * GRID;
	}

	/** Client pixel Y -> grid units. */
	toGridY( clientY ) {
		const r = this.rect;
		return ( ( clientY - r.top ) / r.height ) * GRID;
	}

	/** Grid units -> pixel X within the page element. */
	toLocalX( gx ) { return ( gx / GRID ) * this.rect.width; }

	/** Grid units -> pixel Y within the page element. */
	toLocalY( gy ) { return ( gy / GRID ) * this.rect.height; }

	/** A pixel distance as grid units, horizontally. */
	spanX( px ) { return ( px / this.rect.width ) * GRID; }

	/** A pixel distance as grid units, vertically. */
	spanY( px ) { return ( px / this.rect.height ) * GRID; }
}

/*
 * Grid units are the *display* unit, not the storage unit.
 *
 * Storage is always fine units, so changing a page's snap divisor never moves
 * an existing control -- the divisor is a ruler, not a coordinate system.  The
 * property panel converts on the way in and out, so a human still reads and
 * types column numbers the way the original config did.
 */

/** Fine units -> coarse grid units, for display. */
export function toGridUnits( v, divisor ) {
	return divisor ? ( v * divisor ) / GRID : v / 100;
}

/** Coarse grid units -> fine units, for hand-entered values. */
export function fromGridUnits( v, divisor ) {
	return Math.round( divisor ? ( v * GRID ) / divisor : v * 100 );
}
