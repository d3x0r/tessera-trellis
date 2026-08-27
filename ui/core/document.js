/**
 * @fileoverview Document model: Canvas -> Page -> Control.
 *
 * Deliberately free of ambient "current page" state.  The C version's
 * InterShell_GetCurrentLoadingCanvas() / GetCurrentButton() / ShellGetCurrentPage()
 * are exactly what made the multi-window branch expensive -- every one of them
 * had to become a threaded PPAGE.  Nothing here reads a global; a control
 * reaches its page through inst.page and its canvas through inst.page.canvas.
 *
 * Back-references are private fields so they never serialize.
 */

import { JSOX } from "jsox";
import { SaltyRNG } from "@d3x0r/srg2";
import { GRID } from "./coords.js";
import { getControlDef } from "./registry.js";
import { defaultProps } from "./properties.js";
import { Style, makePropsView, valueOrigin } from "./styles.js";

/*
 * Control ids must be unique across every client that may touch a document,
 * because a control id is what a button sends to the server to say which
 * control was pressed.  A per-session counter would hand two clients the same
 * id for different controls; random ids need no coordination, which is also
 * what the op log will want.
 *
 * SaltyRNG.Id() is the house short id: 12 bytes as 16 base64 characters, with
 * the low bytes of the current second in the leading bytes.  That time prefix
 * is worth more than the extra entropy -- ids sort roughly chronologically, so
 * they index well when they become primary keys in the op log, and two ids
 * generated in different seconds cannot collide at all.
 *
 * The same call works on both sides: srg2 resolves bare in node and through the
 * importmap in the browser, so the server and the client mint ids identically.
 */
function newId() {
	return SaltyRNG.Id();
}

/**
 * A *deterministic* id, hashed from a seed string.
 *
 * SaltyRNG.Id(s) hashes rather than randomises, and uses a separate generator
 * so it does not disturb the random stream.  That is what makes importing an
 * old .isp config idempotent: the source has no ids of its own, so deriving
 * them from stable content means a re-import produces the same ids instead of
 * a fresh set -- no duplicate controls, and no op-log churn for a file that
 * did not change.
 *
 * Only for ids that must be reproducible. Everything else uses newId().
 *
 * @param {string} seed
 */
export function idFor( seed ) {
	return SaltyRNG.Id( String( seed ) );
}

export class Control {
	type = "";
	x = 0; y = 0; w = 1000; h = 1000;

	/*
	 * ONLY the values set on this control -- not the defaults, and not anything
	 * inherited from a preset.  This is what serializes, and keeping it sparse
	 * is what makes the cascade possible: a dense object cannot distinguish
	 * "deliberately this colour" from "nobody ever touched it".
	 */
	own = {};

	/** Name of a canvas style preset, or null. */
	preset = null;

	/** Token set; empty means unrestricted. */
	security = null;

	#page = null;
	#view = null;

	constructor( type, x, y, w, h, props ) {
		this.type = type;
		if( x !== undefined ) { this.x = x; this.y = y; this.w = w; this.h = h; }
		if( props ) Object.assign( this.own, props );
		this.id = newId();
	}

	/**
	 * Effective values: own -> preset -> schema default.
	 *
	 * A live view, so control modules keep reading `inst.props.color` and the
	 * property panel keeps writing `props.color = x` without knowing a cascade
	 * exists.  Writes land on `own`; `delete props.color` reverts to the preset.
	 */
	get props() {
		return this.#view || ( this.#view = makePropsView( this.own,
			() => this.style,
			() => defaultProps( ( getControlDef( this.type ) || {} ).properties ) ) );
	}

	/** Replacing props wholesale replaces the local overrides. */
	set props( values ) {
		this.own = Object.assign( {}, values );
		this.#view = null;
	}

	/** The resolved preset object, or null. */
	get style() {
		const canvas = this.#page && this.#page.canvas;
		return ( canvas && this.preset && canvas.styles[ this.preset ] ) || null;
	}

	/** Where this key's value comes from: "local" | "preset" | "default". */
	originOf( key ) { return valueOrigin( this.own, this.style, key ); }

	/** Drop a local override so the preset (or default) shows through again. */
	revert( key ) { delete this.own[ key ]; }

	get page() { return this.#page; }
	/** @package -- set by Page.add/remove only. */
	_setPage( page ) { this.#page = page; }

	get right()  { return this.x + this.w; }
	get bottom() { return this.y + this.h; }

	contains( gx, gy ) {
		return gx >= this.x && gx < this.right && gy >= this.y && gy < this.bottom;
	}

	intersects( x1, y1, x2, y2 ) {
		return this.x < x2 && this.right > x1 && this.y < y2 && this.bottom > y1;
	}
}

export class Page {
	title = "";
	/*
	 * Pages are soft-deleted, which is why the C editor had both "Destroy Page"
	 * and "Undestroy Page".  Undestroy only reaches back as far as the last
	 * save: the flag is a private field so it never serializes, and compact()
	 * drops the pages for good on the way out.
	 */
	#deleted = false;
	background = { color: "#1a1a22", image: null };
	/**
	 * Show this page when the shell goes idle.
	 *
	 * A flag on the page rather than a title stored on the canvas, so renaming
	 * the page cannot quietly detach the screen saver.
	 *
	 * Several pages may carry it: they are then shown in turn, each for its own
	 * screensaverSeconds, which is how a rotating attract loop is built out of
	 * ordinary pages rather than a special slideshow control.
	 */
	screensaver = false;
	/** Seconds to show this page while idle. 0 = hold it until activity. */
	screensaverSeconds = 0;

	/*
	 * An HTML fragment loaded into a shadow root on this page, behind the
	 * controls.
	 *
	 * Unlike a Web Page control this is NOT an iframe: popups2's fillFromURL
	 * re-hosts the fragment's <script> tags in the shell's own realm, so the
	 * module runs here -- it can call shell APIs, and its input is visible to
	 * the idle watcher without any postMessage relay.
	 *
	 * The price is the exact mirror of that: no sandbox, no origin boundary,
	 * and fetch() means same-origin or CORS. Only for content you control.
	 */
	embed = { url: "", origin: "" };
	/** @type {Control[]} */
	controls = [];

	#canvas = null;

	constructor( title ) {
		if( title !== undefined ) this.title = title;
	}

	get canvas() { return this.#canvas; }
	/** @package */
	_setCanvas( canvas ) { this.#canvas = canvas; }

	get deleted() { return this.#deleted; }
	set deleted( gone ) { this.#deleted = !!gone; }

	add( control ) {
		/*
		 * Make uniqueness certain rather than merely likely.  The document is
		 * the only scope an id has to be unique in, and we can see all of it,
		 * so there is no reason to leave it to probability.
		 */
		if( this.#canvas )
			while( this.#canvas.controlById( control.id ) ) control.id = newId();

		control._setPage( this );
		this.controls.push( control );
		return control;
	}

	remove( control ) {
		const i = this.controls.indexOf( control );
		if( i < 0 ) return false;
		this.controls.splice( i, 1 );
		control._setPage( null );
		return true;
	}

	/** Topmost control at a grid point, or null. */
	hit( gx, gy ) {
		for( let i = this.controls.length - 1; i >= 0; i-- )
			if( this.controls[ i ].contains( gx, gy ) ) return this.controls[ i ];
		return null;
	}
}

export class Canvas {
	title = "Untitled";
	/** @type {Page[]} */
	pages = [];

	/*
	 * Named style presets, referenced live by controls.  Names are paths
	 * ("casino/Danger") so the picker is the same tree the create-control menu
	 * uses.
	 * @type {Object<string,Style>}
	 */
	styles = {};

	/*
	 * Controls that render on every page -- the header/footer bar, a watermark,
	 * a persistent status light.  Deliberately just another Page rather than a
	 * new kind of thing: it serializes, hit-tests, snaps and secures through
	 * exactly the same code, and a shared control at y:500 means the same as a
	 * page control at y:500.
	 */
	/** @type {?Page} */
	shared = null;

	/*
	 * Where the shared bar leaves room for page content, in the same fine units
	 * as everything else.  A GUIDE, not a constraint: it seeds where new page
	 * controls land and it is drawn in the editor, but a page control may be
	 * placed anywhere -- the free space in a control bar is a fine place for
	 * one.  Insets exist on all four sides, so a left rail works like a header.
	 *
	 * Keeping this advisory is what stops a header from costing us the single
	 * coordinate space that makes the rest of this simple.
	 */
	body = { left: 0, top: 0, right: GRID, bottom: GRID };

	/*
	 * Font presets, by name.  The original spelled these `font preset %m=%b`
	 * with binary render data because it drove its own text engine; the browser
	 * equivalent is a CSS font shorthand.
	 * @type {Object<string,{font:string}>}
	 */
	fonts = {};

	/*
	 * Glare sets defined by THIS document, merged over the built-in ones.
	 * Also document data in the original (`round button up=images/...`), which
	 * is why they have to live here to be editable rather than in the module
	 * registry -- that registry now supplies defaults only.
	 * @type {Object<string,object>}
	 */
	glares = {};

	/** Editor snap grid; storage is always GRID units regardless. */
	grid = { divisorX: 24, divisorY: 18 };

	/*
	 * Idle timeout in minutes; 0 disables it.  Expected to be long -- a station
	 * can sit untouched for hours between shifts -- which is why the watcher
	 * polls a timestamp rather than arming one enormous timer.
	 */
	idle = { minutes: 0 };

	constructor( title ) {
		if( title !== undefined ) this.title = title;
		this.shared = new Page( "(shared)" );
		this.shared._setCanvas( this );
	}

	/** Reserve a header and/or footer band, in fine units. */
	setBands( headerHeight, footerHeight ) {
		this.body.top = headerHeight || 0;
		this.body.bottom = GRID - ( footerHeight || 0 );
		return this.body;
	}

	get headerHeight() { return this.body.top; }
	get footerHeight() { return GRID - this.body.bottom; }

	addPage( page ) {
		page._setCanvas( this );
		this.pages.push( page );
		return page;
	}

	pageNamed( title ) {
		return this.pages.find( p => p.title === title ) || null;
	}

	/** Pages that are actually usable. */
	livePages() { return this.pages.filter( p => !p.deleted ); }

	deletedPages() { return this.pages.filter( p => p.deleted ); }

	/**
	 * Discard destroyed pages for good.  Called on the way to storage, which is
	 * what makes undestroy last exactly until the next save.
	 * @returns {Page[]} what was dropped
	 */
	compact() {
		const gone = this.deletedPages();
		if( gone.length ) this.pages = this.livePages();
		return gone;
	}

	pageTitles() { return this.livePages().map( p => p.title ); }

	/**
	 * Pages to show while idle, in page order.
	 *
	 * A list, not one page: order here is the order of the attract loop, so
	 * rearranging it is rearranging the pages.
	 */
	screensaverPages() {
		return this.livePages().filter( p => p.screensaver );
	}

	/** The first idle page, or null. */
	screensaverPage() {
		return this.screensaverPages()[ 0 ] || null;
	}

	/**
	 * Resolve a nextPage value to an actual page.
	 *
	 * Besides a page title, a handful of SYMBOLIC targets are accepted. They
	 * are written in parentheses so they cannot collide with a page someone
	 * named "next", and they are resolved here rather than at the button so
	 * every navigation path -- a control, an action, a timer -- agrees on what
	 * they mean.
	 *
	 *   (first)            first live page
	 *   (next)/(previous)  step through live pages, wrapping
	 *   (next screensaver) step through the attract loop, wrapping
	 *
	 * The stepping ones need to know where you are now, hence `from`.
	 *
	 * @param {string} target
	 * @param {?Page} from  the current page
	 * @returns {?Page}
	 */
	resolvePage( target, from ) {
		if( !target ) return null;
		const name = String( target ).trim();

		const step = ( list, by ) => {
			if( !list.length ) return null;
			const at = from ? list.indexOf( from ) : -1;
			// Not in this list (or nowhere yet): start at its beginning.
			if( at < 0 ) return list[ by > 0 ? 0 : list.length - 1 ];
			return list[ ( at + by + list.length ) % list.length ];
		};

		switch( name.toLowerCase() ) {
		case "(first)":            return this.livePages()[ 0 ] || null;
		case "(next)":             return step( this.livePages(), 1 );
		case "(previous)":         return step( this.livePages(), -1 );
		case "(next screensaver)": return step( this.screensaverPages(), 1 );
		default:                   return this.pageNamed( name );
		}
	}

	/**
	 * Move a page one step earlier or later among the LIVE pages.
	 *
	 * Page order is not cosmetic any more: it is the attract loop's order and
	 * what `(next)` steps through.
	 *
	 * The swap happens in the full `pages` array while the neighbour is chosen
	 * from the live ones, so a destroyed page sitting between two live pages
	 * keeps its slot and reappears where it was if undestroyed -- rather than
	 * being shuffled by an operation that never mentioned it.
	 *
	 * @param {Page} page
	 * @param {number} delta  -1 earlier, +1 later
	 * @returns {boolean} whether anything moved
	 */
	movePage( page, delta ) {
		const live = this.livePages();
		const from = live.indexOf( page );
		const to = from + delta;
		if( from < 0 || to < 0 || to >= live.length ) return false;

		const other = live[ to ];
		const a = this.pages.indexOf( page ), b = this.pages.indexOf( other );
		if( a < 0 || b < 0 ) return false;
		this.pages[ a ] = other;
		this.pages[ b ] = page;
		return true;
	}

	/** Symbolic targets a page picker should offer alongside real titles. */
	static get PAGE_TOKENS() {
		return [ "(first)", "(next)", "(previous)", "(next screensaver)" ];
	}

	/**
	 * A page title not already taken.
	 * @param {string} base
	 * @param {Page} [except]  a page allowed to keep its own name, so renaming
	 *                         a page to what it is already called is not treated
	 *                         as a collision
	 */
	uniquePageTitle( base, except ) {
		let title = base, n = 1;
		while( this.pages.some( p => p !== except && p.title === title ) )
			title = `${base} ${++n}`;
		return title;
	}

	/** Controls referencing a preset; how the editor knows what a change hits. */
	controlsUsingStyle( name ) {
		const out = [];
		for( const page of this.allPages() )
			for( const control of page.controls )
				if( control.preset === name ) out.push( control );
		return out;
	}

	styleNames() { return Object.keys( this.styles ).sort(); }

	fontNames() { return Object.keys( this.fonts ).sort(); }

	/**
	 * Where a font preset is referenced.
	 *
	 * Two places, because a style preset can govern `font` too -- so a control
	 * may be using a font without naming it itself.  Both are reported, since
	 * deleting the font breaks either route.
	 *
	 * @param {string} name
	 * @returns {{controls:Control[], styles:string[]}}
	 */
	fontUsage( name ) {
		const controls = [];
		for( const page of this.allPages() )
			for( const control of page.controls )
				if( control.props.font === name ) controls.push( control );

		const styles = Object.entries( this.styles )
			.filter( ( [ , style ] ) => style.values && style.values.font === name )
			.map( ( [ styleName ] ) => styleName );

		return { controls, styles };
	}

	/** Which controls reference a glare set, by name. */
	glareUsage( name ) {
		const controls = [];
		for( const page of this.allPages() )
			for( const control of page.controls )
				if( control.props.style === name ) controls.push( control );
		const styles = Object.entries( this.styles )
			.filter( ( [ , style ] ) => style.values && style.values.style === name )
			.map( ( [ styleName ] ) => styleName );
		return { controls, styles };
	}

	/** Resolve a font preset name to a CSS font shorthand. */
	fontFor( name ) {
		const preset = name && this.fonts[ name ];
		return preset ? preset.font : "";
	}

	/** Every page including the shared layer. */
	allPages() {
		return this.shared ? this.pages.concat( this.shared ) : this.pages.slice();
	}

	/**
	 * Resolve a control id.  This is what the server uses to turn "the user
	 * pressed control X" into an action and its arguments, without ever taking
	 * either of those from the client.
	 */
	controlById( id ) {
		for( const page of this.allPages() )
			for( const control of page.controls )
				if( control.id === id ) return control;
		return null;
	}

	/** Re-establish back-references after a JSOX revive. */
	relink() {
		const link = ( page ) => {
			page._setCanvas( this );
			for( const control of page.controls ) control._setPage( page );
		};
		for( const page of this.pages ) link( page );
		if( this.shared ) link( this.shared );
		return this;
	}
}

JSOX.addType( "Style", Style );
JSOX.addType( "Control", Control );
JSOX.addType( "Page", Page );
JSOX.addType( "Canvas", Canvas );

export function stringify( canvas ) {
	return JSOX.stringify( canvas );
}

export function parse( text ) {
	const canvas = JSOX.parse( text );
	return canvas instanceof Canvas ? canvas.relink() : canvas;
}

export { GRID };
