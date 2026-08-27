/**
 * @fileoverview Table — a data control.
 *
 * The mirror of a button: a button sends, this receives.  Receipt lists, search
 * results and status tables are all this control with a different source.
 *
 * The control does not know what a receipt is.  It names a source; the server
 * owns the query, the arguments and the columns.  That is what stops every new
 * report needing a new control module.
 */

import { registerControl } from "../core/registry.js";
import { PropType } from "../core/properties.js";

let protocolModule;
export function useProtocol( mod ) { protocolModule = mod; }
function getProtocol() { return protocolModule && protocolModule.protocol; }

/** Exported so plugins can render rows without reimplementing a table. */
export function renderRows( el, columns, rows ) {
	el.textContent = "";
	const table = document.createElement( "table" );
	table.className = "tt-table";

	const head = document.createElement( "thead" );
	const hr = document.createElement( "tr" );
	for( const col of columns ) {
		const th = document.createElement( "th" );
		th.textContent = col.label || col.key;
		if( col.align ) th.style.textAlign = col.align;
		hr.appendChild( th );
	}
	head.appendChild( hr );
	table.appendChild( head );

	const body = document.createElement( "tbody" );
	for( const row of rows ) {
		const tr = document.createElement( "tr" );
		for( const col of columns ) {
			const td = document.createElement( "td" );
			const v = row[ col.key ];
			td.textContent = v === undefined || v === null ? "" : String( v );
			if( col.align ) td.style.textAlign = col.align;
			tr.appendChild( td );
		}
		// A selected row becomes press-time input for whatever button acts on it.
		tr.addEventListener( "click", () => {
			for( const other of body.children ) other.classList.remove( "tt-row-selected" );
			tr.classList.add( "tt-row-selected" );
			el.dispatchEvent( new CustomEvent( "tt-row",
				{ bubbles: true, detail: { row } } ) );
		} );
		body.appendChild( tr );
	}
	table.appendChild( body );
	el.appendChild( table );
}

async function refresh( el, inst ) {
	const protocol = getProtocol();
	if( !protocol ) { el.textContent = "(no connection)"; return; }

	// Name the control, never the query -- same rule as invoking an action.
	const reply = await protocol.query( inst.id, el._ttFilter || {} );
	if( !reply.ok ) { el.textContent = `(${reply.error})`; return; }

	const columns = ( inst.props.columns && inst.props.columns.length )
		? inst.props.columns : reply.columns;
	renderRows( el, columns, reply.rows );
}

registerControl( "data/Table", {
	description: "Rows from a named server source.",
	properties: {
		source:     { type: PropType.Choice, label: "Source", default: "",
		              from: "sources" },
		sourceArgs: { type: PropType.Args,   label: "Source settings", default: null },
		columns:    { type: PropType.Args,   label: "Columns (blank = source default)",
		              default: null },
		refreshMs:  { type: PropType.Number, label: "Auto refresh (ms)", default: 0 },
		security:   { type: PropType.Security, label: "Security" },
	},

	create() {
		const el = document.createElement( "div" );
		el.className = "tt-table-host";
		el.textContent = "(no data yet)";
		return el;
	},

	onShow( el, inst ) {
		refresh( el, inst );
		const ms = Number( inst.props.refreshMs ) || 0;
		if( ms >= 250 ) el._ttTimer = setInterval( () => refresh( el, inst ), ms );
	},

	onHide( el ) {
		if( el._ttTimer ) { clearInterval( el._ttTimer ); el._ttTimer = null; }
	},

	// Querying while the designer drags things around is pure noise.
	onEditBegin( el ) {
		if( el._ttTimer ) { clearInterval( el._ttTimer ); el._ttTimer = null; }
	},

	onEditEnd( el, inst ) { refresh( el, inst ); },

	dispose( el ) {
		if( el._ttTimer ) clearInterval( el._ttTimer );
	},
} );
