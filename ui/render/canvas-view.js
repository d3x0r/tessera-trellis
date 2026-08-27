/**
 * @fileoverview The renderer.
 *
 * Loads a Canvas and draws it.  Knows nothing about editing -- the editor
 * layers on top of this and is served from a different URL, so the overlay
 * and its machinery never reach a runtime page at all.
 *
 * No ambient current-page state: everything a control needs arrives through
 * its instance.
 */

import { Events } from "sack.vfs/Events2";
import { PageMetrics } from "../core/coords.js";
import { getControlDef } from "../core/registry.js";
import { testSecurity } from "../core/security.js";

export class CanvasView extends Events {
	#canvas;
	#host;
	#pageEl;
	#metrics;
	#page = null;
	#sharedEl;
	/** @type {Map<Control,{el:HTMLElement,inner:HTMLElement,def:object}>} */
	#views = new Map();
	/** Whether the editor has taken over; new controls must be told too. */
	#editing = false;
	/** Background <video>, when the page asks for one. */
	#videoEl = null;
	/** Shadow host for a page embed, when the page asks for one. */
	#embedEl = null;
	/** Whether embeds actually execute. Off in the designer -- see #showEmbed. */
	#embeds = true;
	/** Whether to hide controls the session may not use. Off in the designer. */
	#security = true;
	#resizeObserver;

	/**
	 * @param {Canvas} canvas
	 * @param {HTMLElement} host  container the page fills
	 */
	/**
	 * @param {Canvas} canvas
	 * @param {HTMLElement} host
	 * @param {{embeds?:boolean}} [opts]  embeds:false renders a placeholder
	 *        instead of executing page embeds; the designer passes it.
	 */
	constructor( canvas, host, opts ) {
		super();
		this.#canvas = canvas;
		this.#host = host;
		if( opts && opts.embeds === false ) this.#embeds = false;
		if( opts && opts.security === false ) this.#security = false;

		this.#pageEl = document.createElement( "div" );
		this.#pageEl.className = "tt-page";
		host.appendChild( this.#pageEl );

		/*
		 * The shared layer sits above the page layer, so a header bar always
		 * wins visually.  It is built once and survives every page change --
		 * that is the whole difference between shared and per-page.
		 */
		this.#sharedEl = document.createElement( "div" );
		this.#sharedEl.className = "tt-shared";
		host.appendChild( this.#sharedEl );

		this.#metrics = new PageMetrics( this.#pageEl );

		this.#resizeObserver = new ResizeObserver( () => {
			this.#metrics.invalidate();
			this.on( "resize", [] );
		} );
		this.#resizeObserver.observe( this.#pageEl );
		window.addEventListener( "scroll", () => this.#metrics.invalidate(), true );

		// Controls navigate by dispatching an event that bubbles to the page,
		// so no control ever needs a reference to the view it lives in.
		this.#pageEl.addEventListener( "tt-navigate", ( e ) => {
			if( !e.detail || !e.detail.page ) return;
			/*
			 * Resolved here, not at the control: "(next)" depends on where you
			 * are now, and the view is what knows that. Doing it here also
			 * means every navigation path agrees on what the tokens mean.
			 */
			const target = typeof e.detail.page === "string"
				? this.#canvas.resolvePage( e.detail.page, this.#page )
				: e.detail.page;
			if( target ) this.showPage( target );
			else console.warn( `no page for '${e.detail.page}'` );
		} );
	}

	get canvas()  { return this.#canvas; }
	get sharedElement() { return this.#sharedEl; }
	get page()    { return this.#page; }
	get element() { return this.#pageEl; }
	get metrics() { return this.#metrics; }

	/*
	 * Events come from sack.vfs/Events2: on(name, fn) subscribes, on(name, args)
	 * dispatches, off(name, fn) unsubscribes.
	 *
	 * Events2 always spreads an array argument into the callback's parameters,
	 * so a dispatch payload is wrapped in an array -- and a payload that IS an
	 * array has to be wrapped again, or its elements arrive as separate
	 * arguments.  Hence on( "x", [ list ] ) rather than on( "x", list ).
	 */

	/** @param {Page|string} which */
	showPage( which ) {
		const page = typeof which === "string" ? this.#canvas.pageNamed( which ) : which;
		if( !page ) throw new Error( `no page '${which}'` );
		if( page === this.#page ) return page;

		if( this.#page ) {
			// Only page-scoped views; the shared layer persists by definition.
			for( const control of this.#page.controls ) this.#destroyView( control );
			this.on( "pageHidden", [ this.#page ] );
		}

		this.#page = page;
		this.showBackground();

		for( const control of page.controls ) this.#buildView( control );
		this.on( "pageShown", [ page ] );
		return page;
	}

	/**
	 * Re-apply the current page's background.
	 *
	 * Separate from showPage so the page-properties editor can repaint the
	 * background live without tearing down and rebuilding every control.
	 */
	showBackground() {
		const page = this.#page;
		if( !page ) return;
		const colour = page.background.color || "transparent";
		this.#pageEl.style.background = page.background.image
			? `center/cover no-repeat url(${JSON.stringify( page.background.image )}), ${colour}`
			: colour;
		this.#showBackgroundVideo( page.background );
		this.#showEmbed( page );
	}

	/**
	 * Load a page's HTML fragment into a shadow root behind the controls.
	 *
	 * fillFromURL re-hosts the fragment's <script> tags in THIS document, so
	 * the fragment runs in the shell's realm rather than an iframe's. That is
	 * the point -- it can reach shell APIs, and its input reaches the idle
	 * watcher with no postMessage relay -- and also why the designer does not
	 * execute it: a fragment with full DOM access, running while you arrange a
	 * layout, can reach straight into the editor. Design time gets a
	 * placeholder naming the URL; the runtime gets the real thing.
	 *
	 * Imported dynamically so a document with no embeds never pays for it.
	 */
	async #showEmbed( page ) {
		const url = ( page.embed && page.embed.url ) || "";
		if( this.#embedEl ) { this.#embedEl.remove(); this.#embedEl = null; }
		if( !url ) return;

		const holder = document.createElement( "div" );
		holder.className = "tt-page-embed";
		this.#embedEl = holder;
		// After the video, before every control: DOM order is paint order.
		this.#pageEl.insertBefore( holder,
			this.#videoEl ? this.#videoEl.nextSibling : this.#pageEl.firstChild );

		if( !this.#embeds ) {
			holder.classList.add( "tt-page-embed-stub" );
			holder.textContent = `embed — ${url}`;
			return;
		}

		try {
			const { fillFromURL } = await import( "@d3x0r/popups2/core/fill-from-url.js" );
			// The page may have changed while the import and fetch were in flight.
			if( this.#embedEl !== holder ) return;
			await fillFromURL( holder, url,
				page.embed.origin ? { origin: page.embed.origin } : undefined );
		} catch( err ) {
			console.warn( `page embed ${url} failed:`, err.message );
			if( this.#embedEl === holder ) {
				holder.classList.add( "tt-page-embed-stub" );
				holder.textContent = `embed failed — ${url}`;
			}
		}
	}

	/**
	 * A looping video behind the controls -- what a screen-saver page wants.
	 *
	 * `muted` is not a preference: browsers block audible autoplay outright, so
	 * an unmuted background video would simply never start.  `playsinline`
	 * stops iOS taking it fullscreen.  `pointer-events: none` because a <video>
	 * swallows clicks exactly the way an iframe does, and the overlay owns
	 * input.  Inserted as the FIRST child so DOM order puts it behind every
	 * control without needing a z-index.
	 */
	#showBackgroundVideo( background ) {
		const src = ( background && background.video ) || "";
		if( !src ) {
			if( this.#videoEl ) { this.#videoEl.remove(); this.#videoEl = null; }
			return;
		}

		let video = this.#videoEl;
		if( !video ) {
			video = this.#videoEl = document.createElement( "video" );
			video.className = "tt-page-video";
			video.muted = true;
			video.autoplay = true;
			video.playsInline = true;
			this.#pageEl.insertBefore( video, this.#pageEl.firstChild );
		}
		video.loop = background.videoLoop !== false;
		// Only on change; reassigning src restarts playback.
		if( video.getAttribute( "src" ) !== src ) video.setAttribute( "src", src );
		this.#syncVideoPlayback();
	}

	/*
	 * Paused while editing, for the same reason the Web Page control covers
	 * itself: a moving background is a poor thing to arrange a layout against,
	 * and a still frame is what you actually need to judge contrast against.
	 */
	#syncVideoPlayback() {
		const video = this.#videoEl;
		if( !video ) return;
		if( this.#editing ) video.pause();
		else video.play().catch( () => { /* autoplay refused; leave the frame */ } );
	}

	/** Build the shared layer. Idempotent; call after loading a document. */
	buildShared() {
		const shared = this.#canvas.shared;
		if( !shared ) return;
		for( const control of [ ...this.#views.keys() ] )
			if( control.page === shared ) this.#destroyView( control );
		for( const control of shared.controls ) this.#buildView( control );
	}

	/** Which layer owns this control -- decides where its element is parented. */
	#hostFor( control ) {
		return control.page === this.#canvas.shared ? this.#sharedEl : this.#pageEl;
	}

	/** Navigate by page title; what a button's nextPage does. */
	setPage( title ) { return this.showPage( title ); }

	/** Build (or rebuild) the DOM for one control. */
	#buildView( control ) {
		const def = getControlDef( control.type );
		if( !def ) {
			console.warn( `no control registered as '${control.type}'` );
			return null;
		}
		if( this.#security && !testSecurity( control.security ) ) return null;
		if( def.queryShow && !def.queryShow( control ) ) return null;

		const el = document.createElement( "div" );
		el.className = "tt-control";
		const inner = def.create( control );
		if( inner ) el.appendChild( inner );

		const view = { el, inner, def };
		this.#views.set( control, view );
		this.place( control );
		this.#hostFor( control ).appendChild( el );

		if( def.update ) def.update( inner, control );
		if( def.onShow ) def.onShow( inner, control );

		/*
		 * A control created while edit mode is ALREADY on never saw
		 * onEditBegin, so it would carry on animating, reloading or playing
		 * under the designer -- the exact thing that hook exists to stop.
		 * Placing a control is the common way to meet this, so catch it here
		 * rather than expecting every control to check for itself.
		 */
		if( this.#editing && def.onEditBegin ) def.onEditBegin( inner, control );

		return view;
	}

	#destroyView( control ) {
		const view = this.#views.get( control );
		if( !view ) return;
		if( view.def.onHide )  view.def.onHide( view.inner, control );
		if( view.def.dispose ) view.def.dispose( view.inner, control );
		view.el.remove();
		this.#views.delete( control );
	}

	/** Push a control's grid rect onto its element. The only layout write. */
	place( control ) {
		const view = this.#views.get( control );
		if( !view ) return;
		const s = view.el.style;
		s.setProperty( "--x", control.x );
		s.setProperty( "--y", control.y );
		s.setProperty( "--w", control.w );
		s.setProperty( "--h", control.h );
	}

	/** Re-run a control's update() after its props changed. */
	refresh( control ) {
		const view = this.#views.get( control );
		if( !view ) return;
		if( view.def.update ) view.def.update( view.inner, control );
	}

	/**
	 * Add a control to a layer.
	 * @param {Control} control
	 * @param {Page} [page]   defaults to the visible page; pass canvas.shared
	 *                        to place it on the shared layer
	 * @param {number} [index] array position; defaults to the top. Undo passes
	 *                        it so restoring a deleted control puts it back at
	 *                        its original depth rather than in front.
	 */
	addControl( control, page, index ) {
		const target = page || this.#page;
		if( control.page !== target ) target.add( control );
		this.#buildView( control );
		if( index !== undefined ) this.reindex( control, index );
		this.on( "controlAdded", [ control ] );
		return control;
	}

	/**
	 * Move a control within its layer's stacking order.
	 *
	 * Array position is z-order twice over: DOM sibling order is paint order,
	 * and Page.hit() walks the array backwards, so the two must agree.
	 */
	reindex( control, index ) {
		const page = control.page;
		if( !page ) return;
		const at = page.controls.indexOf( control );
		if( at < 0 ) return;
		const to = Math.max( 0, Math.min( index, page.controls.length - 1 ) );
		if( at !== to ) {
			page.controls.splice( at, 1 );
			page.controls.splice( to, 0, control );
		}

		const view = this.#views.get( control );
		if( !view ) return;
		const host = view.el.parentElement;
		if( !host ) return;
		// Re-seat the element against the next control that has one.
		let before = null;
		for( let i = to + 1; i < page.controls.length; i++ ) {
			const next = this.#views.get( page.controls[ i ] );
			if( next && next.el.parentElement === host ) { before = next.el; break; }
		}
		host.insertBefore( view.el, before );
	}

	removeControl( control ) {
		const owner = control.page;
		this.#destroyView( control );
		( owner || this.#page ).remove( control );
		this.on( "controlRemoved", [ control ] );
	}

	elementFor( control ) {
		const view = this.#views.get( control );
		return view && view.el;
	}

	/** Tell controls the editor took over, so clocks and video can pause. */
	setEditing( editing ) {
		this.#editing = !!editing;
		for( const [ control, view ] of this.#views ) {
			const hook = editing ? view.def.onEditBegin : view.def.onEditEnd;
			if( hook ) hook( view.inner, control );
		}
		this.#pageEl.classList.toggle( "tt-editing", this.#editing );
		this.#syncVideoPlayback();
		if( this.#sharedEl )
			this.#sharedEl.classList.toggle( "tt-editing", this.#editing );
	}

	/** Is the editor currently in control? */
	get editing() { return this.#editing; }

	dispose() {
		for( const control of [ ...this.#views.keys() ] ) this.#destroyView( control );
		this.#resizeObserver.disconnect();
		this.#pageEl.remove();
		this.#sharedEl.remove();
	}
}
