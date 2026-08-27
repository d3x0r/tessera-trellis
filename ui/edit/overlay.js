/**
 * @fileoverview Edit overlay.
 *
 * A single canvas above the page owns all pointer input while editing.  This
 * is not just cheaper than per-control listeners -- it is the only thing that
 * works: a video, an iframe or a canvas control swallows pointer events, so a
 * control that listens on its own DOM node cannot be dragged.  Hit testing
 * against our own rect list makes every control drag identically regardless of
 * what it is made of, and z-order never surprises us.
 *
 * The overlay draws the coarse snap grid, selection, handles and marquee.
 * Coordinates are grid units in the model and pixels only at the moment of
 * drawing.
 */

import { Events } from "sack.vfs/Events2";
import { GRID, snap } from "../core/coords.js";

const HANDLE_PX = 7;
const MIN_SIZE  = 100;     // 1% of the page
const NUDGE     = 10;

/*
 * A click is a zero-distance drag.  Without a threshold, selecting a
 * free-placed control and twitching the mouse snaps it to the nearest cell and
 * silently destroys the placement -- the editor cannot tell an accidental
 * gesture from a deliberate move.  Nothing snaps until the pointer has
 * actually travelled.
 */
const DRAG_THRESHOLD_PX = 3;

/** Handle order: corners then edges. dx/dy say which edges a handle moves. */
const HANDLES = [
	{ id: "nw", fx: 0,  fy: 0,  dx: -1, dy: -1 },
	{ id: "ne", fx: 1,  fy: 0,  dx:  1, dy: -1 },
	{ id: "se", fx: 1,  fy: 1,  dx:  1, dy:  1 },
	{ id: "sw", fx: 0,  fy: 1,  dx: -1, dy:  1 },
	{ id: "n",  fx: .5, fy: 0,  dx:  0, dy: -1 },
	{ id: "e",  fx: 1,  fy: .5, dx:  1, dy:  0 },
	{ id: "s",  fx: .5, fy: 1,  dx:  0, dy:  1 },
	{ id: "w",  fx: 0,  fy: .5, dx: -1, dy:  0 },
];

const CURSORS = {
	nw: "nwse-resize", se: "nwse-resize",
	ne: "nesw-resize", sw: "nesw-resize",
	n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
};

/** Stand-in used until an editor supplies a real History. */
const NO_HISTORY = {
	begin() {}, touch() {}, touchPage() {}, touchCanvas() {},
	commit() { return null; }, abort() {},
	undo() { return null; }, redo() { return null; },
};

export class EditOverlay extends Events {
	#view;
	#canvas;
	#ctx;
	#enabled = false;
	#selection = new Set();
	#drag = null;
	#marquee = null;
	/*
	 * The rectangle left behind by a marquee.  Marking a region IS how a
	 * control gets created -- you rubber-band the space it should occupy and
	 * pick the type from the right-click menu, rather than placing a
	 * default-sized control and resizing it afterwards.
	 */
	#region = null;
	/*
	 * Undo, if the editor wired one.  A null object rather than a null check,
	 * so a gesture brackets itself identically whether or not history exists --
	 * the renderer's own preview page has no history and must still drag.
	 */
	#history = NO_HISTORY;
	#snapEnabled = true;
	/** Which layer the editor is acting on: "page" or "shared". */
	#layer = "page";
	#raf = 0;
	/** EventHandles returned by view.on(), for off() on dispose. */
	#unhook = [];

	/** @param {CanvasView} view */
	constructor( view ) {
		super();
		this.#view = view;

		this.#canvas = document.createElement( "canvas" );
		this.#canvas.className = "tt-overlay";
		view.element.parentElement.appendChild( this.#canvas );
		this.#ctx = this.#canvas.getContext( "2d" );

		// Events2 has no unsubscribe token; keep the pair and call off() later.
		this.#watch( "resize",    () => { this.#resize(); this.invalidate(); } );
		this.#watch( "pageShown", () => { this.clearSelection(); this.invalidate(); } );

		this.#canvas.addEventListener( "pointerdown", this.#onDown );
		this.#canvas.addEventListener( "pointermove", this.#onMove );
		this.#canvas.addEventListener( "pointerup", this.#onUp );
		this.#canvas.addEventListener( "pointercancel", this.#onUp );
		this.#canvas.addEventListener( "dblclick", this.#onDoubleClick );
		this.#canvas.addEventListener( "contextmenu", this.#onContextMenu );
		window.addEventListener( "keydown", this.#onKey );

		this.#resize();
	}

	get enabled() { return this.#enabled; }
	get selection() { return [ ...this.#selection ]; }

	/** @param {?History} h */
	set history( h ) { this.#history = h || NO_HISTORY; }
	get history() { return this.#history; }

	/** The marked rectangle, in grid units, or null. */
	get region() { return this.#region; }

	clearRegion() {
		if( !this.#region ) return;
		this.#region = null;
		this.on( "region", [ null ] );
		this.invalidate();
	}

	/** Free placement: drags keep fine resolution instead of landing on cells. */
	get snapEnabled() { return this.#snapEnabled; }
	set snapEnabled( on ) { this.#snapEnabled = !!on; }

	/**
	 * Editing the page or the shared header/footer layer.  Only the active
	 * layer hit-tests, so a header bar cannot be grabbed by accident while
	 * arranging a page, and vice versa.
	 */
	get layer() { return this.#layer; }
	set layer( which ) {
		if( which === this.#layer ) return;
		this.#layer = which === "shared" ? "shared" : "page";
		this.clearSelection();
		this.invalidate();
	}

	/** The Page object the editor is currently acting on. */
	get target() {
		return this.#layer === "shared"
			? this.#view.canvas.shared
			: this.#view.page;
	}

	/**
	 * Where a *new* control is placed by default, and what the overlay shades.
	 *
	 * A guide, not a wall.  An earlier version clamped page controls out of the
	 * bands, which was wrong: the free space in a control bar is a perfectly
	 * good place to put a page control.  Dragging is bounded by the page only.
	 */
	get placementBounds() {
		if( this.#layer === "shared" ) return { left: 0, top: 0, right: GRID, bottom: GRID };
		const b = this.#view.canvas.body;
		return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
	}

	/** Hard limits on a drag: the page, and nothing narrower. */
	get bounds() {
		return { left: 0, top: 0, right: GRID, bottom: GRID };
	}

	/*
	 * Events2: on(name, fn) subscribes, on(name, args) dispatches, off(name, fn)
	 * unsubscribes.  A dispatch payload is always wrapped in an array because
	 * Events2 spreads arrays into the callback's parameters -- so a payload that
	 * IS an array gets wrapped twice, or its elements arrive as separate
	 * arguments.
	 */
	#watch( event, handler ) {
		// on() returns an EventHandle that already knows its own list, so off()
		// takes the handle directly rather than re-finding the handler by name.
		this.#unhook.push( this.#view.on( event, handler ) );
	}

	enable( on = true ) {
		this.#enabled = on;
		this.#canvas.classList.toggle( "tt-active", on );
		this.#view.setEditing( on );
		if( !on ) this.clearSelection();
		this.#resize();
		this.invalidate();
	}

	clearSelection() {
		if( !this.#selection.size ) return;
		this.#selection.clear();
		this.on( "selection", [ [] ] );
		this.invalidate();
	}

	select( control, additive ) {
		if( !additive ) this.#selection.clear();
		if( control ) {
			if( additive && this.#selection.has( control ) ) this.#selection.delete( control );
			else this.#selection.add( control );
		}
		this.on( "selection", [ this.selection ] );
		this.invalidate();
	}

	invalidate() {
		if( this.#raf ) return;
		this.#raf = requestAnimationFrame( () => { this.#raf = 0; this.#draw(); } );
	}

	#resize() {
		const r = this.#view.metrics.rect;
		const dpr = window.devicePixelRatio || 1;
		this.#canvas.width  = Math.max( 1, Math.round( r.width  * dpr ) );
		this.#canvas.height = Math.max( 1, Math.round( r.height * dpr ) );
		this.#canvas.style.width  = r.width + "px";
		this.#canvas.style.height = r.height + "px";
		this.#ctx.setTransform( dpr, 0, 0, dpr, 0, 0 );
	}

	// -- coordinate helpers ------------------------------------------------

	#toGrid( e ) {
		const m = this.#view.metrics;
		return { gx: m.toGridX( e.clientX ), gy: m.toGridY( e.clientY ) };
	}

	#px( gx, gy ) {
		const m = this.#view.metrics;
		return { x: m.toLocalX( gx ), y: m.toLocalY( gy ) };
	}

	#snapX( v, free ) {
		const off = free || !this.#snapEnabled;
		const b = this.bounds;
		return Math.min( b.right, Math.max( b.left,
			snap( v, off ? 0 : this.#view.canvas.grid.divisorX ) ) );
	}

	#snapY( v, free ) {
		const off = free || !this.#snapEnabled;
		const b = this.bounds;
		return Math.min( b.bottom, Math.max( b.top,
			snap( v, off ? 0 : this.#view.canvas.grid.divisorY ) ) );
	}

	/** Handle under a grid point, searching selected controls only. */
	#hitHandle( gx, gy ) {
		const m = this.#view.metrics;
		const tolX = m.spanX( HANDLE_PX ), tolY = m.spanY( HANDLE_PX );
		for( const control of this.#selection ) {
			for( const h of HANDLES ) {
				const hx = control.x + control.w * h.fx;
				const hy = control.y + control.h * h.fy;
				if( Math.abs( gx - hx ) <= tolX && Math.abs( gy - hy ) <= tolY )
					return { control, handle: h };
			}
		}
		return null;
	}

	// -- pointer -----------------------------------------------------------

	#onDown = ( e ) => {
		if( !this.#enabled ) return;
		const page = this.target;
		if( !page ) return;
		this.#canvas.setPointerCapture( e.pointerId );
		const { gx, gy } = this.#toGrid( e );

		const grab = this.#hitHandle( gx, gy );
		if( grab ) {
			this.#drag = { mode: "resize", handle: grab.handle, gx, gy,
			               downX: e.clientX, downY: e.clientY, pending: true,
			               orig: this.#snapshot() };
			return;
		}

		const hit = page.hit( gx, gy );
		if( !hit ) {
			if( !e.shiftKey ) this.clearSelection();
			this.#marquee = { x1: gx, y1: gy, x2: gx, y2: gy, additive: e.shiftKey };
			this.invalidate();
			return;
		}

		if( !this.#selection.has( hit ) ) this.select( hit, e.shiftKey );
		else if( e.shiftKey ) { this.select( hit, true ); return; }

		this.#drag = { mode: "move", gx, gy,
		               downX: e.clientX, downY: e.clientY, pending: true,
		               orig: this.#snapshot() };
	};

	#onMove = ( e ) => {
		if( !this.#enabled ) return;
		const { gx, gy } = this.#toGrid( e );

		if( this.#marquee ) {
			this.#marquee.x2 = gx;
			this.#marquee.y2 = gy;
			this.invalidate();
			return;
		}
		if( !this.#drag ) {
			this.#canvas.style.cursor = this.#cursorFor( gx, gy );
			return;
		}

		if( this.#drag.pending ) {
			const travel = Math.hypot( e.clientX - this.#drag.downX,
			                           e.clientY - this.#drag.downY );
			if( travel < DRAG_THRESHOLD_PX ) return;
			this.#drag.pending = false;

			/*
			 * The gesture starts here, not at pointerdown: below the threshold
			 * it was a click and must leave no undo entry.  Touching before the
			 * first #dragMove is what makes the captured state pre-drag.
			 */
			this.#history.begin( this.#drag.mode === "move" ? "Move" : "Resize" );
			for( const o of this.#drag.orig ) this.#history.touch( o.control );
		}

		const free = e.altKey;
		if( this.#drag.mode === "move" ) this.#dragMove( gx, gy, free );
		else this.#dragResize( gx, gy, free );

		for( const o of this.#drag.orig ) this.#view.place( o.control );
		this.invalidate();
	};

	#onUp = ( e ) => {
		if( this.#marquee ) {
			const m = this.#marquee;
			const x1 = Math.min( m.x1, m.x2 ), x2 = Math.max( m.x1, m.x2 );
			const y1 = Math.min( m.y1, m.y2 ), y2 = Math.max( m.y1, m.y2 );
			if( !m.additive ) this.#selection.clear();
			for( const control of this.target.controls )
				if( control.intersects( x1, y1, x2, y2 ) ) this.#selection.add( control );
			this.#marquee = null;

			// Keep the swept rectangle as a marked region.  A sweep smaller than
			// half a minimum was a stray click, not a gesture.
			this.#region = ( x2 - x1 > MIN_SIZE / 2 && y2 - y1 > MIN_SIZE / 2 )
				? this.#markRegion( x1, y1, x2, y2 )
				: null;

			this.on( "region", [ this.#region ] );
			this.on( "selection", [ this.selection ] );
			this.invalidate();
			return;
		}
		if( this.#drag && this.#drag.pending ) {
			this.#drag = null;                       // it was a click, not a move
		} else if( this.#drag ) {
			const moved = this.#drag.orig
				.filter( o => o.control.x !== o.x || o.control.y !== o.y
				           || o.control.w !== o.w || o.control.h !== o.h )
				.map( o => o.control );
			this.#drag = null;
			this.#history.commit();
			if( moved.length ) this.on( "changed", [ moved ] );
		}
		if( this.#canvas.hasPointerCapture( e.pointerId ) )
			this.#canvas.releasePointerCapture( e.pointerId );
	};

	#onDoubleClick = ( e ) => {
		if( !this.#enabled ) return;
		const { gx, gy } = this.#toGrid( e );
		const hit = this.target && this.target.hit( gx, gy );
		if( hit ) this.on( "edit", [ hit ] );
	};

	/*
	 * The C editor put create-control on a right-click tree; the overlay owns
	 * the pointer, so it raises the event and the editor decides what the menu
	 * contains.
	 */
	#onContextMenu = ( e ) => {
		if( !this.#enabled ) return;
		e.preventDefault();
		const { gx, gy } = this.#toGrid( e );
		const hit = this.target && this.target.hit( gx, gy );
		if( hit && !this.#selection.has( hit ) ) this.select( hit, false );
		const r = this.#region;
		const inRegion = !!r && gx >= r.x && gx < r.x + r.w
		                    && gy >= r.y && gy < r.y + r.h;

		this.on( "contextmenu",
			[ { gx, gy, control: hit, region: inRegion ? r : null,
			    x: e.clientX, y: e.clientY } ] );
	};

	#onKey = ( e ) => {
		if( !this.#enabled ) return;
		if( e.target && /^(INPUT|TEXTAREA|SELECT)$/.test( e.target.tagName ) ) return;

		// Undo/redo need no selection, so they come before the selection guard.
		if( e.ctrlKey || e.metaKey ) {
			const key = e.key.toLowerCase();
			if( key === "z" && !e.shiftKey ) { e.preventDefault(); this.#history.undo(); return; }
			if( key === "y" || ( key === "z" && e.shiftKey ) ) {
				e.preventDefault(); this.#history.redo(); return;
			}
		}
		if( !this.#selection.size ) return;

		if( e.key === "Escape" ) { this.clearSelection(); this.clearRegion(); return; }
		if( e.key === "Delete" || e.key === "Backspace" ) {
			e.preventDefault();
			const doomed = this.selection;
			this.clearSelection();
			this.#history.begin( doomed.length > 1 ? `Delete ${doomed.length} controls` : "Delete" );
			for( const control of doomed ) {
				this.#history.touch( control );
				this.#view.removeControl( control );
			}
			this.#history.commit();
			this.on( "removed", [ doomed ] );
			this.invalidate();
			return;
		}
		// Plain arrows nudge in fine units so an off-grid control stays off-grid;
		// shift moves by a whole cell of the current ruler.
		const { divisorX, divisorY } = this.#view.canvas.grid;
		const stepX = e.shiftKey ? Math.round( GRID / divisorX ) : NUDGE;
		const stepY = e.shiftKey ? Math.round( GRID / divisorY ) : NUDGE;
		const dx = e.key === "ArrowLeft" ? -stepX : e.key === "ArrowRight" ? stepX : 0;
		const dy = e.key === "ArrowUp"   ? -stepY : e.key === "ArrowDown"  ? stepY : 0;
		if( !dx && !dy ) return;
		e.preventDefault();
		const b = this.bounds;
		/*
		 * A run of arrow presses is one gesture, so they coalesce while the
		 * selection is unchanged -- otherwise nudging a button into place would
		 * cost forty undos to reverse.  The key changes when the selection does,
		 * which ends the run.
		 */
		const runKey = "nudge:" + this.selection.map( c => c.id ).sort().join( "," );
		this.#history.begin( "Nudge", runKey );
		for( const control of this.#selection ) {
			this.#history.touch( control );
			control.x = Math.min( Math.max( control.x + dx, b.left ), b.right - control.w );
			control.y = Math.min( Math.max( control.y + dy, b.top ), b.bottom - control.h );
			this.#view.place( control );
		}
		this.#history.commit();
		this.on( "changed", [ this.selection ] );
		this.invalidate();
	};

	#cursorFor( gx, gy ) {
		const grab = this.#hitHandle( gx, gy );
		if( grab ) return CURSORS[ grab.handle.id ];
		const page = this.target;
		return page && page.hit( gx, gy ) ? "move" : "default";
	}

	#snapshot() {
		return [ ...this.#selection ].map( control =>
			( { control, x: control.x, y: control.y, w: control.w, h: control.h } ) );
	}

	/** Move by a delta snapped against the anchor, so a group stays rigid. */
	#dragMove( gx, gy, free ) {
		const d = this.#drag;
		const anchor = d.orig[ 0 ];
		if( !anchor ) return;
		const dx = this.#snapX( anchor.x + ( gx - d.gx ), free ) - anchor.x;
		const dy = this.#snapY( anchor.y + ( gy - d.gy ), free ) - anchor.y;
		const b = this.bounds;
		for( const o of d.orig ) {
			o.control.x = Math.min( Math.max( o.x + dx, b.left ), b.right - o.w );
			o.control.y = Math.min( Math.max( o.y + dy, b.top ), b.bottom - o.h );
		}
	}

	#dragResize( gx, gy, free ) {
		const d = this.#drag;
		const h = d.handle;
		for( const o of d.orig ) {
			const c = o.control;
			let x = o.x, y = o.y, w = o.w, height = o.h;
			if( h.dx < 0 ) {
				const nx = this.#snapX( o.x + ( gx - d.gx ), free );
				w = Math.max( MIN_SIZE, o.x + o.w - nx );
				x = o.x + o.w - w;
			} else if( h.dx > 0 ) {
				const nr = this.#snapX( o.x + o.w + ( gx - d.gx ), free );
				w = Math.max( MIN_SIZE, nr - o.x );
			}
			if( h.dy < 0 ) {
				const ny = this.#snapY( o.y + ( gy - d.gy ), free );
				height = Math.max( MIN_SIZE, o.y + o.h - ny );
				y = o.y + o.h - height;
			} else if( h.dy > 0 ) {
				const nb = this.#snapY( o.y + o.h + ( gy - d.gy ), free );
				height = Math.max( MIN_SIZE, nb - o.y );
			}
			c.x = x; c.y = y; c.w = w; c.h = height;
		}
	}

	// -- drawing -----------------------------------------------------------

	#draw() {
		const ctx = this.#ctx;
		const r = this.#view.metrics.rect;
		ctx.clearRect( 0, 0, r.width, r.height );
		if( !this.#enabled ) return;

		this.#drawGrid( ctx, r );
		this.#drawBands( ctx, r );
		if( this.#region ) this.#drawRegion( ctx );
		for( const control of this.#selection ) this.#drawSelected( ctx, control );
		if( this.#marquee ) this.#drawMarquee( ctx );
	}

	#drawGrid( ctx, r ) {
		const { divisorX, divisorY } = this.#view.canvas.grid;
		ctx.strokeStyle = "rgba(255,255,255,.07)";
		ctx.lineWidth = 1;
		ctx.beginPath();
		for( let i = 1; i < divisorX; i++ ) {
			const x = Math.round( ( i / divisorX ) * r.width ) + .5;
			ctx.moveTo( x, 0 ); ctx.lineTo( x, r.height );
		}
		for( let i = 1; i < divisorY; i++ ) {
			const y = Math.round( ( i / divisorY ) * r.height ) + .5;
			ctx.moveTo( 0, y ); ctx.lineTo( r.width, y );
		}
		ctx.stroke();
	}

	/**
	 * Rule the shell insets on all four sides.  Faint shading only -- these mark
	 * where the shared bar lives so page content is not hidden by accident, but
	 * nothing is forbidden.
	 */
	#drawBands( ctx, r ) {
		const b = this.#view.canvas.body;
		if( b.left <= 0 && b.top <= 0 && b.right >= GRID && b.bottom >= GRID ) return;

		const x1 = this.#px( b.left, 0 ).x,  x2 = this.#px( b.right, 0 ).x;
		const y1 = this.#px( 0, b.top ).y,   y2 = this.#px( 0, b.bottom ).y;

		ctx.save();
		ctx.fillStyle = "rgba(0,0,0,.18)";
		if( b.top > 0 )       ctx.fillRect( 0, 0, r.width, y1 );
		if( b.bottom < GRID ) ctx.fillRect( 0, y2, r.width, r.height - y2 );
		if( b.left > 0 )      ctx.fillRect( 0, y1, x1, y2 - y1 );
		if( b.right < GRID )  ctx.fillRect( x2, y1, r.width - x2, y2 - y1 );

		ctx.strokeStyle = "rgba(150,200,255,.45)";
		ctx.setLineDash( [ 5, 4 ] );
		ctx.lineWidth = 1;
		ctx.beginPath();
		if( b.top > 0 )       { ctx.moveTo( 0, y1 + .5 ); ctx.lineTo( r.width, y1 + .5 ); }
		if( b.bottom < GRID ) { ctx.moveTo( 0, y2 + .5 ); ctx.lineTo( r.width, y2 + .5 ); }
		if( b.left > 0 )      { ctx.moveTo( x1 + .5, 0 ); ctx.lineTo( x1 + .5, r.height ); }
		if( b.right < GRID )  { ctx.moveTo( x2 + .5, 0 ); ctx.lineTo( x2 + .5, r.height ); }
		ctx.stroke();
		ctx.restore();
	}

	#drawSelected( ctx, control ) {
		const a = this.#px( control.x, control.y );
		const b = this.#px( control.right, control.bottom );
		const w = b.x - a.x, h = b.y - a.y;

		ctx.strokeStyle = "rgba(120,190,255,.95)";
		ctx.lineWidth = 1;
		ctx.strokeRect( a.x + .5, a.y + .5, w, h );

		ctx.fillStyle = "#ffffff";
		ctx.strokeStyle = "rgba(40,90,150,.95)";
		for( const hd of HANDLES ) {
			const hx = a.x + w * hd.fx, hy = a.y + h * hd.fy;
			ctx.fillRect(   hx - HANDLE_PX / 2, hy - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX );
			ctx.strokeRect( hx - HANDLE_PX / 2 + .5, hy - HANDLE_PX / 2 + .5, HANDLE_PX, HANDLE_PX );
		}
	}

	/**
	 * Snap a swept rectangle into a region.
	 *
	 * Snapping the two corners independently can collapse the rectangle to
	 * nothing -- sweep 1200 to 1300 against a 417-unit cell and both ends land
	 * on 1250.  A zero-cell region would then create a zero-size control, so
	 * the region is widened to one whole cell rather than rejected: the sweep
	 * said where, it just did not say how big.
	 */
	#markRegion( x1, y1, x2, y2 ) {
		const grid = this.#view.canvas.grid;
		const minW = this.#snapEnabled ? Math.round( GRID / grid.divisorX ) : MIN_SIZE;
		const minH = this.#snapEnabled ? Math.round( GRID / grid.divisorY ) : MIN_SIZE;

		let x = this.#snapX( x1, false );
		let y = this.#snapY( y1, false );
		let w = Math.max( minW, this.#snapX( x2, false ) - x );
		let h = Math.max( minH, this.#snapY( y2, false ) - y );

		// Growing to the minimum must not push the region off the page.
		if( x + w > GRID ) x = Math.max( 0, GRID - w );
		if( y + h > GRID ) y = Math.max( 0, GRID - h );

		return { x, y, w: Math.min( w, GRID ), h: Math.min( h, GRID ) };
	}

	/** The marked region: where the next created control will go. */
	#drawRegion( ctx ) {
		const a = this.#px( this.#region.x, this.#region.y );
		const b = this.#px( this.#region.x + this.#region.w,
		                    this.#region.y + this.#region.h );
		ctx.save();
		ctx.fillStyle = "rgba(120,255,190,.10)";
		ctx.strokeStyle = "rgba(120,255,190,.85)";
		ctx.lineWidth = 1;
		ctx.setLineDash( [ 3, 3 ] );
		ctx.fillRect( a.x, a.y, b.x - a.x, b.y - a.y );
		ctx.strokeRect( a.x + .5, a.y + .5, b.x - a.x, b.y - a.y );
		ctx.restore();
	}

	#drawMarquee( ctx ) {
		const m = this.#marquee;
		const a = this.#px( Math.min( m.x1, m.x2 ), Math.min( m.y1, m.y2 ) );
		const b = this.#px( Math.max( m.x1, m.x2 ), Math.max( m.y1, m.y2 ) );
		ctx.fillStyle = "rgba(90,160,255,.15)";
		ctx.strokeStyle = "rgba(120,190,255,.9)";
		ctx.lineWidth = 1;
		ctx.fillRect( a.x, a.y, b.x - a.x, b.y - a.y );
		ctx.strokeRect( a.x + .5, a.y + .5, b.x - a.x, b.y - a.y );
	}

	dispose() {
		for( const handle of this.#unhook ) this.#view.off( handle );
		this.#unhook.length = 0;
		window.removeEventListener( "keydown", this.#onKey );
		this.#canvas.remove();
	}
}
