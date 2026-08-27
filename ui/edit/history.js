/**
 * @fileoverview Editor-local undo/redo.
 *
 * An undo stack belongs to an editing *session*, not to a document.  Two
 * editors drifting apart is acceptable here; one editor undoing another's work
 * is not, and a stack shared through the server is exactly the shape that
 * allows it.  Keeping the stack client-local rules that out by construction
 * rather than by rule, which is why nothing in this file talks to the protocol.
 *
 * ## What is an operation?
 *
 * A *completed user gesture that changed the document* -- never an individual
 * mutation.  Concretely:
 *
 *   drag / resize     one entry per gesture (pointerdown..pointerup), not per
 *                     pointermove; a drag below the click threshold is not a
 *                     gesture at all and produces nothing
 *   nudge             one entry per keypress, coalesced while the selection is
 *                     unchanged and the presses keep coming
 *   create / delete /
 *   clone             one entry each
 *   a dialog          ONE entry for the whole session, committed on Okay
 *   page + canvas     create, rename, destroy, undestroy, presets, fonts,
 *                     glares, body insets
 *
 * The dialog case is the interesting one, and it is why live editing and
 * undoability are not in tension. The panel applies every keystroke live --
 * watching the ring change colour as you pick it is the point -- but the undo
 * *granularity* is the whole dialog session. So the stack reads the way the
 * apply-on-Okay crowd wants (one entry per dialog, Cancel leaves no trace)
 * without giving up live preview. Cancel is already a targeted restore inside
 * the panel and simply never commits.
 *
 * ## Records are entity-scoped, not document snapshots
 *
 * Whole-document snapshots would be far simpler, and are wrong here: undoing
 * one would stamp a whole document over whatever another editor had changed
 * meanwhile -- the precise thing that must not happen. Scoping each record to
 * one entity means an undo touches only what that gesture touched, and lets a
 * record notice it has been overtaken.
 *
 * A record therefore stores plain before/after *state bags*, never closures
 * over live objects: a closure captured before a delete goes stale the moment
 * the entity is recreated, whereas a state bag is just compared and applied.
 */

import { JSOX } from "jsox";

const LIMIT = 200;

/** Deep copy of plain property data. */
const clone = ( v ) => v === undefined || v === null ? v : structuredClone( v );

/**
 * Deep copy that KEEPS class identity.
 *
 * structuredClone strips prototypes, which is fine for a control's own props
 * (plain data) and wrong for a canvas key: `canvas.styles` holds Style
 * instances, and restoring plain objects would leave `control.style.governs()`
 * undefined -- an undo that appears to work and breaks the next repaint.
 *
 * JSOX already has these types registered for the document format, so a round
 * trip through it revives them. Falls back to structuredClone if a value is
 * not representable.
 */
function cloneTyped( v ) {
	if( v === undefined || v === null ) return v;
	try { return JSOX.parse( JSOX.stringify( v ) ); }
	catch( err ) { return structuredClone( v ); }
}

/* -- state capture -------------------------------------------------------- */

/**
 * A control's reversible state, or null when it is not in the document.
 *
 * `page` and `index` are part of it: a delete must restore z-order, which is
 * array position -- it decides both paint order and which control `hit()`
 * finds first.
 */
function controlState( control ) {
	const page = control.page;
	if( !page ) return null;
	return {
		page,
		index:    page.controls.indexOf( control ),
		x: control.x, y: control.y, w: control.w, h: control.h,
		own:      clone( control.own ),
		preset:   control.preset,
		security: clone( control.security ),
	};
}

function pageState( page ) {
	const canvas = page.canvas;
	const index = canvas ? canvas.pages.indexOf( page ) : -1;
	return {
		inPages:    index >= 0,
		index,
		title:      page.title,
		deleted:    page.deleted,
		background: clone( page.background ),
	};
}

const sameJson = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );

function sameControlState( a, b ) {
	if( !a || !b ) return a === b;
	return a.page === b.page && a.index === b.index
		&& a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h
		&& a.preset === b.preset
		&& sameJson( a.own, b.own ) && sameJson( a.security, b.security );
}

/** Two page orders, compared by identity -- these are the same objects. */
function sameOrder( a, b ) {
	if( !a || !b || a.length !== b.length ) return false;
	return a.every( ( page, i ) => page === b[ i ] );
}

function samePageState( a, b ) {
	return a.inPages === b.inPages && a.index === b.index && a.title === b.title
		&& a.deleted === b.deleted && sameJson( a.background, b.background );
}

/* -- history -------------------------------------------------------------- */

export class History {
	#view;
	#stack = [];
	/** Everything below #index is undoable; at and above it is redoable. */
	#index = 0;
	#open = null;
	#depth = 0;
	#listeners = new Set();
	#applying = false;

	/** @param {CanvasView} view  used to keep the DOM in step with the model */
	constructor( view ) {
		this.#view = view;
	}

	get canUndo() { return this.#index > 0; }
	get canRedo() { return this.#index < this.#stack.length; }
	get undoLabel() { return this.canUndo ? this.#stack[ this.#index - 1 ].label : null; }
	get redoLabel() { return this.canRedo ? this.#stack[ this.#index ].label : null; }
	get depth() { return this.#stack.length; }

	onChange( cb ) { this.#listeners.add( cb ); return () => this.#listeners.delete( cb ); }
	#changed( info ) { for( const cb of this.#listeners ) cb( info || {} ); }

	/* -- transactions ----------------------------------------------------- */

	/**
	 * Open a transaction.  Nesting is reference-counted, so a helper that
	 * brackets its own work still merges into an enclosing gesture instead of
	 * splitting it into several entries.
	 *
	 * @param {string} label            shown in the UI
	 * @param {string} [coalesceKey]    when set, an immediately preceding entry
	 *                                  with the same key absorbs this one --
	 *                                  how a run of arrow-key nudges stays one
	 *                                  entry instead of forty
	 */
	begin( label, coalesceKey ) {
		if( this.#applying ) return this;         // undo must not record itself
		if( this.#open ) { this.#depth++; return this; }
		this.#open = { label, coalesceKey, records: new Map() };
		this.#depth = 1;
		return this;
	}

	/** Record a control's state before you change it. First call in a txn wins. */
	touch( control ) {
		if( !this.#open || this.#applying ) return control;
		const key = control;
		if( !this.#open.records.has( key ) )
			this.#open.records.set( key,
				{ kind: "control", target: control, before: controlState( control ) } );
		return control;
	}

	touchPage( page ) {
		if( !this.#open || this.#applying ) return page;
		if( !this.#open.records.has( page ) )
			this.#open.records.set( page,
				{ kind: "page", target: page, before: pageState( page ) } );
		return page;
	}

	/**
	 * Record one key of the canvas (styles, fonts, glares, body, grid).
	 * @param {Canvas} canvas
	 * @param {string} key
	 */
	touchCanvas( canvas, key ) {
		if( !this.#open || this.#applying ) return canvas;
		const id = "canvas:" + key;
		if( !this.#open.records.has( id ) )
			this.#open.records.set( id,
				{ kind: "canvas", target: canvas, key, before: clone( canvas[ key ] ) } );
		return canvas;
	}

	/**
	 * Snapshot a control now, to be paired with record() later.
	 *
	 * For editors that are long-lived and may be open several at once -- a
	 * property panel -- where begin()/commit() is the wrong tool: two open
	 * panels would nest into one transaction and the first to finish would
	 * swallow the other's changes.
	 */
	capture( control ) { return controlState( control ); }
	capturePage( page ) { return pageState( page ); }
	/** Snapshot one canvas key (styles, fonts, glares, body, grid). */
	captureCanvas( canvas, key ) { return cloneTyped( canvas[ key ] ); }

	/**
	 * Snapshot the ORDER of the pages -- a shallow copy of the array.
	 *
	 * Deliberately NOT captureCanvas( canvas, "pages" ): cloning would replace
	 * every Page with a copy, and undo would then swap the live objects out
	 * from under the view, the controls' back-references, and anything else
	 * holding a page. Only the sequence changes here, so only the sequence is
	 * stored, and the pages themselves stay the same objects.
	 */
	capturePageOrder( canvas ) { return canvas.pages.slice(); }

	/**
	 * Push an entry for changes that have ALREADY been applied.
	 *
	 * @param {string} label
	 * @param {Array<{kind?:string,target:object,key?:string,before:any}>} records
	 */
	record( label, records ) {
		if( this.#applying ) return null;
		return this.#finalize( label, null,
			records.map( r => ( { kind: r.kind || "control", ...r } ) ) );
	}

	/** Close the transaction, keeping it only if something actually changed. */
	commit() {
		if( this.#applying ) return null;
		if( !this.#open ) return null;
		if( --this.#depth > 0 ) return null;

		const open = this.#open;
		this.#open = null;
		return this.#finalize( open.label, open.coalesceKey, [ ...open.records.values() ] );
	}

	/** Fill in `after`, drop no-ops, and push (or coalesce) the entry. */
	#finalize( label, coalesceKey, candidates ) {
		const records = [];
		for( const record of candidates ) {
			if( record.kind === "control" ) {
				record.after = controlState( record.target );
				if( sameControlState( record.before, record.after ) ) continue;
			} else if( record.kind === "page" ) {
				record.after = pageState( record.target );
				if( samePageState( record.before, record.after ) ) continue;
			} else if( record.kind === "pageOrder" ) {
				record.after = record.target.pages.slice();
				if( sameOrder( record.before, record.after ) ) continue;
			} else {
				record.after = cloneTyped( record.target[ record.key ] );
				if( sameJson( record.before, record.after ) ) continue;
			}
			records.push( record );
		}
		if( !records.length ) return null;

		// Anything redoable is now unreachable; a new branch discards it.
		if( this.#index < this.#stack.length ) this.#stack.length = this.#index;

		const previous = this.#stack[ this.#stack.length - 1 ];
		if( coalesceKey && previous && previous.coalesceKey === coalesceKey ) {
			absorb( previous, records );
		} else {
			this.#stack.push( { label, coalesceKey, records } );
			if( this.#stack.length > LIMIT ) this.#stack.shift();
		}
		this.#index = this.#stack.length;
		this.#changed( { committed: true } );
		return this.#stack[ this.#stack.length - 1 ];
	}

	/** Discard the open transaction. The document is left as it stands. */
	abort() {
		if( this.#applying ) return;
		if( !this.#open ) return;
		if( --this.#depth > 0 ) return;
		this.#open = null;
	}

	/** Run fn inside a transaction, aborting it if fn throws. */
	transact( label, fn, coalesceKey ) {
		this.begin( label, coalesceKey );
		try {
			const result = fn();
			this.commit();
			return result;
		} catch( err ) {
			this.abort();
			throw err;
		}
	}

	/* -- undo / redo ------------------------------------------------------ */

	undo() { return this.#step( -1 ); }
	redo() { return this.#step( 1 ); }

	#step( direction ) {
		if( this.#open ) this.commit();          // an unclosed gesture is finished first
		const entry = direction < 0
			? ( this.canUndo ? this.#stack[ this.#index - 1 ] : null )
			: ( this.canRedo ? this.#stack[ this.#index ] : null );
		if( !entry ) return null;

		/*
		 * Records whose entity has moved on since -- someone else changed it,
		 * or a later local edit did -- are skipped rather than re-applied.  An
		 * undo that reinstates a stale value on top of a newer change is worse
		 * than an undo that declines.
		 */
		const stale = [];
		const doing = [];
		for( const record of entry.records ) {
			const expected = direction < 0 ? record.after : record.before;
			if( this.#matches( record, expected ) ) doing.push( record );
			else stale.push( record );
		}

		this.#applying = true;
		try {
			// Reverse order on undo so an index restore lands against the same
			// array shape the forward pass left behind.
			const ordered = direction < 0 ? [ ...doing ].reverse() : doing;
			for( const record of ordered )
				this.#apply( record, direction < 0 ? record.before : record.after );
		} finally {
			this.#applying = false;
		}

		this.#index += direction;
		this.#changed( { entry, direction, applied: doing.length, stale: stale.length } );
		return { entry, applied: doing.length, stale: stale.length };
	}

	#matches( record, expected ) {
		if( record.kind === "control" ) return sameControlState( controlState( record.target ), expected );
		if( record.kind === "page" )    return samePageState( pageState( record.target ), expected );
		if( record.kind === "pageOrder" ) return sameOrder( record.target.pages, expected );
		return sameJson( record.target[ record.key ], expected );
	}

	#apply( record, state ) {
		// Reassign the sequence; the Page objects are unchanged by design.
		if( record.kind === "pageOrder" ) { record.target.pages = state.slice(); return; }
		if( record.kind === "canvas" ) { record.target[ record.key ] = cloneTyped( state ); return; }
		if( record.kind === "page" )   { this.#applyPage( record.target, state ); return; }
		this.#applyControl( record.target, state );
	}

	#applyPage( page, state ) {
		const canvas = page.canvas;
		page.title = state.title;
		page.deleted = state.deleted;
		page.background = clone( state.background );
		if( canvas ) {
			const at = canvas.pages.indexOf( page );
			if( state.inPages && at < 0 )
				canvas.pages.splice( Math.min( state.index, canvas.pages.length ), 0, page );
			else if( !state.inPages && at >= 0 )
				canvas.pages.splice( at, 1 );
			else if( at >= 0 && at !== state.index ) {
				canvas.pages.splice( at, 1 );
				canvas.pages.splice( Math.min( state.index, canvas.pages.length ), 0, page );
			}
		}
		if( this.#view.page === page ) this.#view.showBackground();
	}

	#applyControl( control, state ) {
		const view = this.#view;
		if( !state ) {
			if( control.page ) view.removeControl( control );
			return;
		}

		/*
		 * Show the page the change belongs to.  Undoing something you cannot
		 * see is disorienting, and the renderer only builds elements for the
		 * visible page and the shared layer -- so this is also what keeps the
		 * DOM correct rather than merely being good manners.
		 */
		const canvas = view.canvas;
		if( state.page !== canvas.shared && view.page !== state.page )
			view.showPage( state.page );

		control.x = state.x; control.y = state.y;
		control.w = state.w; control.h = state.h;
		control.props = state.own;              // setter replaces own, clears the cascade cache
		control.preset = state.preset;
		control.security = clone( state.security );

		if( !control.page ) {
			view.addControl( control, state.page, state.index );
		} else if( control.page !== state.page ) {
			view.removeControl( control );
			view.addControl( control, state.page, state.index );
		} else {
			view.reindex( control, state.index );
			view.place( control );
			view.refresh( control );
		}
	}

	/** Forget everything -- a fresh document is a fresh session. */
	clear() {
		this.#stack.length = 0;
		this.#index = 0;
		this.#open = null;
		this.#depth = 0;
		this.#changed( { cleared: true } );
	}
}

/**
 * Fold a coalesced gesture into the entry before it.
 *
 * Only `after` moves: the earlier entry's `before` is the state the run began
 * from, which is exactly what one undo of the whole run should restore.
 */
function absorb( entry, records ) {
	for( const record of records ) {
		const existing = entry.records.find( r =>
			r.kind === record.kind && r.target === record.target && r.key === record.key );
		if( existing ) existing.after = record.after;
		else entry.records.push( record );
	}
}
