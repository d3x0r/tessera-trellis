/**
 * @fileoverview sideplayr sessions: the client half.
 *
 * Deliberately small.  The Session Manager document is built from the stock
 * Table, Field and Button controls, so all this half adds is what a document
 * can only REFER to:
 *
 *   %Selected Session   the row picked in a sessions table, for the header
 *   %Session Result     what the last press did, for the footer
 *
 * the wiring that makes every open window refresh when any of them changes a
 * session (the server broadcasts sessionsChanged), and one cell type:
 *
 *   "pattern"   an animated preview of a game's pattern, from the pattern
 *               service, that opens the pattern picker when clicked and
 *               sends the choice through the table's action
 */

import { defineVariable, setVariable } from "../../core/variables.js";
import { watchInputs, getInput } from "../../core/inputs.js";
import { formatCell, registerCellType } from "../../controls/table.js";

const when = ( iso ) => formatCell( iso, { type: "datetime" } );

defineVariable( "Selected Session", "no session selected" );
defineVariable( "Session Result", "" );

/** Row objects the tables handed us, by id, so the header can show a name. */
const known = new Map();

document.addEventListener( "tt-row", ( e ) => {
	const row = e.detail && e.detail.row;
	if( row && row.Id !== undefined && row.name !== undefined ) known.set( String( row.Id ), row );
	describe();
} );

watchInputs( ( name ) => { if( name === "sessionId" ) describe(); } );

function describe() {
	const id = getInput( "sessionId" );
	if( id === undefined || id === null || id === "" ) {
		setVariable( "Selected Session", "no session selected" );
		return;
	}
	const row = known.get( String( id ) );
	setVariable( "Selected Session", row ? `#${id} ${row.name}${row.startAt ? " - " + when( row.startAt ) : ""}` : `#${id}` );
}

/** The footer line: a one-sentence account of the last press. */
document.addEventListener( "tt-invoked", ( e ) => {
	const reply = e.detail && e.detail.reply;
	if( !reply ) return;
	if( reply.ok === false ) { setVariable( "Session Result", "Refused: " + ( reply.error || "unknown" ) ); return; }
	const r = reply.result || {};
	if( !r.action ) return;     // a fetch (details), not a change: nothing to announce
	let text;
	switch( r.action ) {
	case "cloned":   text = `Created session #${r.sessionId} "${r.name}" starting ${when( r.startAt )} with ${r.games} games`; break;
	case "updated":  text = r.changed ? `Updated session #${r.id}` : `Nothing to change on session #${r.id}`; break;
	case "status":   text = `Session #${r.id} is now ${r.status}`; break;
	case "template": text = `Session #${r.id} ${r.template ? "is now a template" : "is no longer a template"}`; break;
	case "deleted":  text = `Deleted session #${r.id}`; break;
	case "room":     text = r.room ? `Session #${r.id} is on the floor in ${r.room}` : `Session #${r.id} is off the floor`; break;
	case "pattern":  text = `Game #${r.gameId} now plays "${r.pattern}"`; break;
	case "bank":     text = `Opened "${r.name}" for session #${r.sessionId} with ${r.balance}`; break;
	case "bankReleased": text = `Released the bank from session #${r.sessionId}`; break;
	case "game":     text = r.changed ? `Saved game ${r.no ?? ""} ${r.name ?? "#" + r.gameId}`.trim()
	                                  + ( r.packsAdded || r.packsRemoved ? ` (packs +${r.packsAdded} -${r.packsRemoved})` : "" )
	                                  : `Nothing changed on game #${r.gameId}`; break;
	default:         text = "Done";
	}
	setVariable( "Session Result", text );
} );

export function useProtocol( mod ) {
	const protocol = mod && mod.protocol;
	if( !protocol ) return;
	// Someone (maybe another window) changed a session: every table re-queries.
	protocol.on( "sessionsChanged", () => {
		document.dispatchEvent( new CustomEvent( "tt-refresh" ) );
	} );
}

// -- the "pattern" cell -------------------------------------------------------
//
// The preview and the picker are the pattern service's own modules, imported
// from its origin (it serves them with CORS); the column says where that is
// (`col.service`, from the server plugin's config).  Loaded once, lazily, so
// a document without a pattern column never touches the service.

const serviceModules = new Map();
let pickerOpen = false;
function patternModules( service ) {
	if( !serviceModules.has( service ) )
		serviceModules.set( service, Promise.all( [
			import( service + "/patternPreview.js" ),
			import( service + "/patternPicker.js" ),
		] ).then( ( [ preview, picker ] ) => ( { ...preview, ...picker } ) ) );
	return serviceModules.get( service );
}

// -- the "details" cell: a button that opens the game editor ------------------
//
// The editor is built from what the server sends: gameDetails (the table's
// "details" slot) answers with a field schema, the option lists and the
// current values, so the form here knows nothing about games -- add a field
// in logic.mjs and it appears.  Save goes back through the "save" slot.

registerCellType( "details", {
	sortKey: () => "",
	render( td, row, col, ctx ) {
		const btn = document.createElement( "button" );
		btn.className = "tt-details-button";
		btn.textContent = "Edit…";
		btn.title = "Edit every property of this game";
		td.appendChild( btn );
		btn.addEventListener( "click", async ( evt ) => {
			evt.stopPropagation();
			btn.disabled = true;
			try { await openRecordPager( ctx.rows(), row, col, ctx ); }
			finally { btn.disabled = false; }
		} );
	},
} );

// -- the "assign" cell: open a bank of this class for the selected session ----
//
// Two slots on the bank classes table: "form" answers with a count-per-
// compartment form (built by the server from the class's compartments), and
// "assign" opens the bank with those counts.  The form is the same record
// editor the games use; its save folds the counts into one input.

registerCellType( "assign", {
	sortKey: () => "",
	render( td, row, col, ctx ) {
		const btn = document.createElement( "button" );
		btn.className = "tt-details-button";
		btn.textContent = "Open…";
		btn.title = "Open a bank of this class for the selected session";
		td.appendChild( btn );
		btn.addEventListener( "click", async ( evt ) => {
			evt.stopPropagation();
			if( getInput( "sessionId" ) === undefined ) { setVariable( "Session Result", "Pick a session first" ); return; }
			btn.disabled = true;
			try {
				const reply = await ctx.invoke( { bankId: row.Id }, "form" );
				if( !reply || reply.ok === false ) { setVariable( "Session Result", "Refused: " + ( reply && reply.error || "no form" ) ); return; }
				openRecordDialog( reply.result, col, ctx, "assign" );
			} finally { btn.disabled = false; }
		} );
	},
} );

/** One record form in an overlay, saving through the given slot. */
function openRecordDialog( record, col, ctx, slot ) {
	const overlay = document.createElement( "div" );
	overlay.className = "tt-record-overlay";
	const frame = document.createElement( "div" );
	frame.className = "tt-record";
	overlay.appendChild( frame );
	const close = () => { document.removeEventListener( "keydown", onKey, true ); overlay.remove(); };
	const onKey = ( e ) => { if( e.key === "Escape" ) { e.stopPropagation(); close(); } };
	document.addEventListener( "keydown", onKey, true );
	overlay.addEventListener( "click", ( e ) => { if( e.target === overlay ) close(); } );
	const form = buildRecordForm( record, col, ctx, {
		onClose: close,
		onSaved: close,
		saveSlot: slot,
		saveLabel: record.saveLabel || "Open Bank",
		alwaysSave: true,
	} );
	frame.appendChild( form.el );
	document.body.appendChild( overlay );
}

// Double-clicking a row of a table that has an Edit column opens the same
// editor the button does, on that row.
document.addEventListener( "tt-row-open", ( e ) => {
	const d = e.detail || {};
	const col = ( d.columns || [] ).find( c => c.type === "details" );
	if( !col || !d.ctx || !d.row ) return;
	openRecordPager( d.rows, d.row, col, d.ctx );
} );

/**
 * One editor, paged: a tab per game (by game number) across the top, and
 * Prev / Next below, so a session is walked through game by game without
 * closing and reopening.  Each page is fetched when its tab is shown; unsaved
 * edits ask before the page changes.
 */
async function openRecordPager( rows, startRow, col, ctx ) {
	const overlay = document.createElement( "div" );
	overlay.className = "tt-record-overlay";
	const frame = document.createElement( "div" );
	frame.className = "tt-record tt-record-pager";
	overlay.appendChild( frame );

	const tabs = document.createElement( "div" );
	tabs.className = "tt-record-tabs";
	const pageHost = document.createElement( "div" );
	frame.append( tabs, pageHost );
	document.body.appendChild( overlay );

	let current = null;        // { row, form:{ dirty(), save() } }
	const tabEls = new Map();

	const closeAll = () => { document.removeEventListener( "keydown", onKey, true ); overlay.remove(); };
	const onKey = ( e ) => { if( e.key === "Escape" ) { e.stopPropagation(); leave(); } };
	document.addEventListener( "keydown", onKey, true );
	overlay.addEventListener( "click", ( e ) => { if( e.target === overlay ) leave(); } );

	/** may we abandon the current page?  save if asked; false stays put */
	async function settle() {
		if( !current || !current.form.dirty() ) return true;
		if( !window.confirm( `Save changes to ${current.form.title}?\n\nOK saves, Cancel discards them.` ) ) return true;
		return current.form.save();
	}
	async function leave() { if( await settle() ) closeAll(); }

	async function show( row ) {
		if( current && current.row === row ) return;
		if( !await settle() ) return;
		pageHost.textContent = "Loading…";
		const reply = await ctx.invoke( { gameId: row.Id }, "details" );
		if( !reply || reply.ok === false ) {
			pageHost.textContent = "Refused: " + ( reply && reply.error || "no details" );
			return;
		}
		for( const [ r, el ] of tabEls ) el.classList.toggle( "tt-record-tab-current", r === row );
		pageHost.textContent = "";
		const form = buildRecordForm( reply.result, col, ctx, {
			onLabel: ( text ) => label( row, text ),
			onSaved: () => { const t = tabEls.get( row ); if( t ) t.classList.remove( "tt-record-tab-dirty" ); },
			onDirty: () => { const t = tabEls.get( row ); if( t ) t.classList.add( "tt-record-tab-dirty" ); },
			onClose: leave,
			prev: rows.indexOf( row ) > 0 ? () => show( rows[ rows.indexOf( row ) - 1 ] ) : null,
			next: rows.indexOf( row ) < rows.length - 1 ? () => show( rows[ rows.indexOf( row ) + 1 ] ) : null,
		} );
		pageHost.appendChild( form.el );
		current = { row, form };
		const t = tabEls.get( row );
		if( t && t.scrollIntoView ) t.scrollIntoView( { inline: "nearest", block: "nearest" } );
	}

	// a tab reads "<game #>  <alias>", the alias being what a floor knows a game by
	function label( row, alias ) {
		const t = tabEls.get( row );
		if( !t ) return;
		const a = ( alias === undefined ? row.alias : alias ) || "";
		t.textContent = "";
		const no = document.createElement( "span" );
		no.className = "tt-record-tab-no";
		no.textContent = String( row.no ?? row.Id );
		t.append( no, document.createTextNode( a ? " " + a : "" ) );
		t.title = a || row.name || "";
	}
	for( const r of rows ) {
		const t = document.createElement( "button" );
		t.type = "button";
		t.className = "tt-record-tab";
		t.addEventListener( "click", () => show( r ) );
		tabs.appendChild( t );
		tabEls.set( r, t );
		label( r );
	}
	await show( startRow );
}

/**
 * A form over a server-sent record: { title, fields:[{group}|{key,label,type,options}], values }.
 * Types: string, number, bool, choice, multi (checkbox set -> CSV), pattern (the picker).
 * Returns { el, title, dirty(), save() }; the pager supplies prev/next/close.
 */
function buildRecordForm( record, col, ctx, hooks = {} ) {
	const values = { ...record.values };
	let dirty = false;
	const touch = () => { dirty = true; if( hooks.onDirty ) hooks.onDirty(); };
	const form = document.createElement( "form" );
	form.className = "tt-record-page";
	form.addEventListener( "submit", ( e ) => e.preventDefault() );

	const h = document.createElement( "h2" );
	h.textContent = record.title || "Details";
	form.appendChild( h );

	let grid = null;
	const section = ( name ) => {
		const g = document.createElement( "div" );
		g.className = "tt-record-group";
		g.textContent = name;
		form.appendChild( g );
		grid = document.createElement( "div" );
		grid.className = "tt-record-fields";
		form.appendChild( grid );
	};
	section( "" );
	grid.previousSibling.remove();

	const patternService = ( record.fields.find( f => f.type === "pattern" ) || {} ).service || col.service;
	const rerenders = [];     // parts that follow another field (packs follow the card type)

	for( const f of record.fields ) {
		if( !f.key ) { section( f.group ); continue; }
		const wrap = document.createElement( "label" );
		wrap.className = "tt-record-field";
		const caption = document.createElement( "span" );
		caption.textContent = f.label;
		const v = values[ f.key ];

		if( f.type === "bool" ) {
			wrap.classList.add( "tt-record-check" );
			const box = document.createElement( "input" );
			box.type = "checkbox";
			box.checked = !!v;
			box.addEventListener( "change", () => { values[ f.key ] = box.checked; touch(); } );
			wrap.append( box, caption );
		} else if( f.type === "choice" ) {
			const sel = document.createElement( "select" );
			const none = document.createElement( "option" );
			none.value = ""; none.textContent = "(none)";
			sel.appendChild( none );
			for( const o of f.options || [] ) {
				const opt = document.createElement( "option" );
				opt.value = String( o.value ); opt.textContent = o.text;
				sel.appendChild( opt );
			}
			sel.value = v === null || v === undefined ? "" : String( v );
			sel.addEventListener( "change", () => {
				values[ f.key ] = sel.value === "" ? null : Number( sel.value );
				touch();
				// the pack list depends on the card type and the paytable
				if( f.key === "GameCardTypeId" || f.key === "PaytableId" ) for( const r of rerenders ) r();
			} );
			wrap.append( caption, sel );
		} else if( f.type === "multi" ) {
			// the pack list, limited to packs of the game's card type: a double
			// action pack cannot play in a regular game.  Follows the card type
			// select live; a chosen pack of another type stays listed, flagged,
			// so it can be unticked rather than silently kept.
			const chosen = new Set( ( Array.isArray( v ) ? v : [] ).map( Number ) );
			const list = document.createElement( "div" );
			list.className = "tt-record-multi";
			// Order: chosen packs that are wrong first (wrong card type, or not
			// paid by the paytable), then the rest of the chosen, then the
			// others alphabetically.  Re-sorted on every tick, so a pack just
			// chosen moves up; the change event has already fired by then, so
			// nothing is under the mouse that a move could disturb.
			const render = () => {
				const cardType = Number( values.GameCardTypeId || record.gameCardTypeId ) || 0;
				const paytable = Number( values.PaytableId || record.sessionPaytableId ) || 0;
				const wrongType = ( o ) => cardType && Number( o.group ) !== cardType;
				const unpaid = ( o ) => paytable && Array.isArray( o.paytables ) && !o.paytables.includes( paytable );
				const rank = ( o ) => {
					const on = chosen.has( Number( o.value ) );
					return on && ( wrongType( o ) || unpaid( o ) ) ? 0 : on ? 1 : 2;
				};
				list.textContent = "";
				const opts = ( f.options || [] )
					.filter( o => !cardType || Number( o.group ) === cardType || chosen.has( Number( o.value ) ) )
					.sort( ( a, b ) => rank( a ) - rank( b ) || a.text.localeCompare( b.text ) );
				if( !opts.length ) list.textContent = "(no packs for this card type)";
				for( const o of opts ) {
					const l = document.createElement( "label" );
					const box = document.createElement( "input" );
					box.type = "checkbox";
					box.checked = chosen.has( Number( o.value ) );
					box.addEventListener( "change", () => {
						if( box.checked ) chosen.add( Number( o.value ) ); else chosen.delete( Number( o.value ) );
						values[ f.key ] = [ ...chosen ].join( "," );
						touch();
						render();
					} );
					l.append( box, document.createTextNode( o.text ) );
					if( wrongType( o ) ) { l.classList.add( "tt-record-mismatch" ); l.title = "not a pack of this card type"; }
					else if( box.checked && unpaid( o ) ) { l.classList.add( "tt-record-unpaid" ); l.title = "the paytable has no payout rules for this pack"; }
					list.appendChild( l );
				}
			};
			render();
			rerenders.push( render );
			values[ f.key ] = [ ...chosen ].join( "," );
			wrap.append( caption, list );
			wrap.style.gridColumn = "1 / -1";
		} else if( f.type === "counts" ) {
			// The cash-entry grid: one row per compartment, a count to type,
			// unit value, what is on hand, the line total, and the totals under
			// it -- the bank service's Enter Counts form, in the record editor.
			const unit = f.unit || 1;
			const dollars = ( n ) => "$" + ( n / unit ).toLocaleString( "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 } );
			const map = ( v && "object" === typeof v ) ? { ...v } : {};
			values[ f.key ] = map;
			// "On hand" only means something once somebody holds cash; a bank
			// being opened has none, so the column stays out of the way
			const showOnHand = ( f.rows || [] ).some( r => r.onHand );
			const table = document.createElement( "table" );
			table.className = "tt-counts";
			table.innerHTML = "<thead><tr><th>Compartment</th><th>Unit value</th>" + ( showOnHand ? "<th>On hand</th>" : "" ) + "<th>Count</th><th>Line total</th></tr></thead>";
			const body = document.createElement( "tbody" );
			const lineEls = new Map();
			for( const r of f.rows || [] ) {
				const tr = document.createElement( "tr" );
				const td = ( text, cls ) => { const c = document.createElement( "td" ); c.textContent = text; if( cls ) c.className = cls; tr.appendChild( c ); return c; };
				td( r.name, "tt-counts-name" );
				td( dollars( r.scalar ), "tt-counts-num" );
				if( showOnHand ) td( String( r.onHand || 0 ), "tt-counts-num" );
				const cell = document.createElement( "td" );
				cell.className = "tt-counts-count";
				const box = document.createElement( "input" );
				box.type = "number"; box.min = "0"; box.step = "1";
				box.value = map[ r.id ] || 0;
				box.addEventListener( "focus", () => box.select() );
				box.addEventListener( "input", () => { map[ r.id ] = Math.max( 0, Math.round( Number( box.value ) || 0 ) ); refresh(); touch(); } );
				cell.appendChild( box );
				tr.appendChild( cell );
				lineEls.set( r.id, td( dollars( 0 ), "tt-counts-num" ) );
				body.appendChild( tr );
			}
			table.appendChild( body );
			const totals = document.createElement( "div" );
			totals.className = "tt-counts-totals";
			const onHandUnits = ( f.rows || [] ).reduce( ( a, r ) => a + ( r.onHand || 0 ) * r.scalar, 0 );
			const refresh = () => {
				let entered = 0;
				for( const r of f.rows || [] ) { const line = ( map[ r.id ] || 0 ) * r.scalar; entered += line; lineEls.get( r.id ).textContent = dollars( line ); }
				totals.innerHTML = "";
				const lines = showOnHand
					? [ [ "Balance on hand", onHandUnits ], [ "Entered", entered ], [ "Resulting balance", onHandUnits + entered ] ]
					: [ [ "Starting balance", entered ] ];
				for( const [ label, n ] of lines ) {
					const row = document.createElement( "div" );
					const l = document.createElement( "span" ); l.textContent = label + ":";
					const a = document.createElement( "span" ); a.textContent = dollars( n );
					row.append( l, a );
					totals.appendChild( row );
				}
			};
			refresh();
			wrap.append( caption, table, totals );
			wrap.style.gridColumn = "1 / -1";
		} else if( f.type === "pattern" ) {
			const line = document.createElement( "div" );
			line.className = "tt-record-pattern";
			const name = document.createElement( "span" );
			name.textContent = record.patternName || ( v ? "#" + v : "(none)" );
			const pick = document.createElement( "button" );
			pick.type = "button";
			pick.textContent = "Choose…";
			pick.addEventListener( "click", async () => {
				if( !patternService ) { status.textContent = "no pattern service configured"; return; }
				let mod;
				try { mod = await patternModules( patternService ); }
				catch( err ) { status.textContent = "pattern service unreachable: " + err.message; return; }
				try {
					// the picker is held to the game's card type; only its patterns apply
					const picked = await mod.pickPattern( { gameCardTypeId: values.GameCardTypeId || record.gameCardTypeId, lockType: true, patternId: values[ f.key ] } );
					values[ f.key ] = picked.id;
					name.textContent = picked.pattern.PatternType || "#" + picked.id;
					touch();
				} catch( err ) { /* cancelled */ }
			} );
			line.append( name, pick );
			wrap.append( caption, line );
		} else {
			const box = document.createElement( "input" );
			box.type = f.type === "number" ? "number" : "text";
			box.value = v === null || v === undefined ? "" : String( v );
			box.addEventListener( "input", () => {
				values[ f.key ] = box.value;
				touch();
				// the pager's tab shows the alias; keep it current while typing
				if( f.key === "AliasName" && hooks.onLabel ) hooks.onLabel( box.value );
			} );
			wrap.append( caption, box );
		}
		grid.appendChild( wrap );
	}

	// a running total over the fields that carry a scalar (a counts form)
	let totalEl = null;
	if( record.total ) {
		totalEl = document.createElement( "div" );
		totalEl.className = "tt-record-total";
		form.appendChild( totalEl );
		const unit = record.total.unit || 1;
		const show = () => {
			let sum = 0;
			for( const f of record.fields ) if( f.key && f.scalar ) sum += ( Number( values[ f.key ] ) || 0 ) * f.scalar;
			totalEl.textContent = `${record.total.label || "Total"}: $${( sum / unit ).toLocaleString( "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 } )}`;
		};
		show();
		form.addEventListener( "input", show );
	}

	const status = document.createElement( "div" );
	status.className = "tt-record-status";
	const buttons = document.createElement( "div" );
	buttons.className = "tt-record-buttons";
	const mk = ( text, cls, onClick, enabled = true ) => {
		const b = document.createElement( "button" );
		b.type = "button"; b.className = cls || ""; b.textContent = text; b.disabled = !enabled;
		b.addEventListener( "click", onClick );
		buttons.appendChild( b );
		return b;
	};
	// paging buttons only where there is something to page through
	if( hooks.prev !== undefined || hooks.next !== undefined ) {
		mk( "◀ Prev", "tt-record-nav", () => hooks.prev && hooks.prev(), !!hooks.prev );
		mk( "Next ▶", "tt-record-nav", () => hooks.next && hooks.next(), !!hooks.next );
	}
	const spacer = document.createElement( "span" );
	spacer.style.flex = "1";
	buttons.appendChild( spacer );
	mk( "Close", "tt-record-cancel", () => hooks.onClose && hooks.onClose() );
	const save = mk( hooks.saveLabel || "Save", "", () => api.save() );
	form.append( status, buttons );

	const api = {
		el: form,
		title: record.title || "Details",
		dirty: () => dirty,
		/** resolves true when saved (or nothing to save), false when refused */
		async save() {
			if( !dirty && !hooks.alwaysSave ) return true;
			save.disabled = true;
			status.textContent = "Saving…";
			// only the editable keys travel; the server keeps the ones it declares.
			// record.ids are the keys of what is being edited; record.collapse
			// folds a family of fields (sub_12, sub_13...) into one "id:value,..."
			// input, the way a counts form travels.
			const out = { ...( record.ids || {} ) };
			if( record.gameId ) out.gameId = record.gameId;
			const fold = record.collapse;
			const folded = [];
			for( const f of record.fields ) {
				if( !f.key || !( f.key in values ) ) continue;
				const v = values[ f.key ] === null ? "" : values[ f.key ];
				if( f.type === "counts" ) out[ f.key ] = Object.entries( v || {} ).filter( ( [ , q ] ) => Number( q ) > 0 ).map( ( [ id, q ] ) => id + ":" + q ).join( "," );
				else if( fold && f.key.startsWith( fold.prefix ) ) { if( Number( v ) ) folded.push( f.key.slice( fold.prefix.length ) + ":" + v ); }
				else out[ f.key ] = v;
			}
			if( fold ) out[ fold.into ] = folded.join( "," );
			const reply = await ctx.invoke( out, hooks.saveSlot || "save" );
			save.disabled = false;
			if( !reply || reply.ok === false ) { status.textContent = "Refused: " + ( reply && reply.error || "unknown" ); return false; }
			dirty = false;
			status.textContent = "Saved.";
			if( hooks.onSaved ) hooks.onSaved();
			return true;
		},
	};

	setTimeout( () => { const first = form.querySelector( "input[type=text], input[type=number], select" ); if( first ) first.focus(); }, 0 );
	return api;
}

registerCellType( "pattern", {
	sortKey: ( row, col ) => row[ col.key ],
	render( td, row, col, ctx ) {
		td.classList.add( "tt-pattern-cell" );
		const name = document.createElement( "span" );
		name.className = "tt-pattern-name";
		name.textContent = row[ col.key ] || "(no pattern)";
		const holder = document.createElement( "span" );
		holder.className = "tt-pattern-preview";
		td.append( holder, name );
		td.title = "Click to choose a pattern";

		const service = col.service;
		if( !service ) return;

		let view = null;
		patternModules( service ).then( ( mod ) => {
			view = mod.makePatternPreview( { size: 36, palette: { markShape: "circle" } } );
			holder.appendChild( view.el );
			if( row.patternId ) view.setPatternId( row.patternId );
		} ).catch( ( err ) => { holder.textContent = "?"; holder.title = "pattern service: " + err.message; } );

		td.addEventListener( "click", async ( evt ) => {
			evt.stopPropagation();      // a click here picks a pattern, not the row
			if( pickerOpen ) return;    // one picker at a time; a double-click is one request
			let mod;
			try { mod = await patternModules( service ); }
			catch( err ) { setVariable( "Session Result", "Pattern service unreachable: " + err.message ); return; }
			let picked;
			pickerOpen = true;
			try { picked = await mod.pickPattern( { gameCardTypeId: row.gameCardTypeId, lockType: true, patternId: row.patternId } ); }
			catch( err ) { return; }    // cancelled
			finally { pickerOpen = false; }
			const reply = await ctx.invoke( { gameId: row.Id, patternId: picked.id } );
			if( reply && reply.ok !== false ) {
				name.textContent = picked.pattern.PatternType || String( picked.id );
				if( view ) view.setMasks( picked.pattern.masks || [] );
			}
		} );
	},
} );
