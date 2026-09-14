/**
 * @fileoverview Table — a data control.
 *
 * The mirror of a button: a button sends, this receives.  Receipt lists, search
 * results and status tables are all this control with a different source.
 *
 * The control does not know what a receipt is.  It names a source; the server
 * owns the query, the arguments and the columns.  That is what stops every new
 * report needing a new control module.
 *
 * A table is also a PRODUCER of press-time input: give it an input name and
 * the key column, and picking a row publishes that row's key under that name
 * (see core/inputs.js).  A button on the same document then carries it, which
 * is how "the session you clicked" reaches "Go Live" without any wiring.
 *
 * And it is a consumer: the query sends the current inputs along with its own
 * filter, so a source can be scoped by another control's selection -- the
 * games of whichever session the sessions table has selected.
 */

import { registerControl } from "../core/registry.js";
import { PropType } from "../core/properties.js";
import { gatherInputs, setInput, watchInputs } from "../core/inputs.js";
import { DataGrid } from "@d3x0r/popups2/controls/data-grid.js";
import { invoke } from "../core/actions.js";

let protocolModule;
export function useProtocol( mod ) { protocolModule = mod; }
function getProtocol() { return protocolModule && protocolModule.protocol; }

const two = n => String( n ).padStart( 2, "0" );

/**
 * A column may declare a type; instants (ISO text) are shown in the viewer's
 * own zone, which is the whole reason the server sends instants and not the
 * database's wall-clock text.
 *
 * Dates are spelled year-first so the grid's column sort -- which compares the
 * displayed text -- orders them correctly without a comparator per type.
 */
export function formatCell( v, col ) {
	if( v === undefined || v === null || v === "" ) return "";
	const type = col && col.type;
	if( type === "bool" ) return v && v !== "0" && v !== "false" && v !== "no" ? "✓" : "";
	if( type === "datetime" || type === "date" || type === "time" ) {
		const d = new Date( v );
		if( isNaN( d ) ) return String( v );
		const date = `${d.getFullYear()}-${two( d.getMonth() + 1 )}-${two( d.getDate() )}`;
		const time = `${two( d.getHours() )}:${two( d.getMinutes() )}`;
		return type === "date" ? date : type === "time" ? time : date + " " + time;
	}
	return String( v );
}

/**
 * Cell renderers by column TYPE, so a plugin can teach the table how to draw
 * a kind of value -- a pattern preview, a thumbnail -- without the table
 * knowing what it is.  A source declares `type` on a column; if a renderer is
 * registered for it, the cell is handed to it instead of being formatted.
 *
 *   registerCellType( "pattern", {
 *       render( td, row, col, ctx ) { ... },     // fill the cell element
 *       sortKey( row, col ) { ... },             // optional; default row[col.key]
 *   } );
 *
 * ctx.invoke( input ) fires the table's own action (see the `action` property)
 * with press-time input -- how a cell that edits something reaches the server
 * through the same gate a button does.
 */
const cellTypes = new Map();
export function registerCellType( name, def ) {
	if( typeof def.render !== "function" ) throw new Error( `cell type '${name}' has no render()` );
	cellTypes.set( name, def );
}

/**
 * Render rows with the popups2 DataGrid, read-only.  Exported so plugins can
 * show rows without reimplementing a table; the grid brings column sorting
 * on its own and, with `filter`, a per-column filter row.
 *
 * @param {HTMLElement} el
 * @param {Array<{key:string,label?:string,type?:string,align?:string}>} columns
 * @param {object[]} rows
 * @param {(row:object)=>void} [onSelect]  called with the row the user picked
 * @param {{filter?:boolean, sortable?:boolean, onFilter?:(ev:object)=>void,
 *          invoke?:(input:object)=>Promise<any>}} [opts]
 * @returns {DataGrid}
 */
export function renderRows( el, columns, rows, onSelect, opts = {} ) {
	el.textContent = "";
	const ctx = {
		invoke: opts.invoke || ( async () => ( { ok: false, error: "no action" } ) ),
		// the rows this render holds, for a renderer that steps between them
		rows: () => rows,
	};
	const grid = new DataGrid( el, { rows }, "rows", {
		suffix: " tt-grid",
		edit: false,                          // no sentinel "new row"; this is a view
		filter: !!opts.filter,
		noSort: opts.sortable === false,
		columns: columns.map( col => {
			const custom = cellTypes.get( col.type );
			const type = custom
				// a registered renderer owns the cell; sorting compares its key
				? { edit: false, custom: {
					fill( cell ) { if( cell.row.rowData ) custom.render( cell.el, cell.row.rowData, col, ctx ); },
					refresh() {},
					sort( a, b ) {
						const key = custom.sortKey || ( ( row ) => row[ col.key ] );
						const av = String( key( a.rowData, col ) ?? "" ), bv = String( key( b.rowData, col ) ?? "" );
						return av < bv ? -1 : av > bv ? 1 : 0;
					},
				} }
				// toString makes a cell read-only text; the grid's own sort and
				// filter both read that text, so the formatting decides their order.
				: { edit: false, toString: ( row ) => formatCell( row[ col.key ], col ) };
			return {
				name: col.label || col.key,
				field: col.key,
				className: col.align === "right" ? " tt-grid-right" : col.align === "center" ? " tt-grid-center" : "",
				type,
			};
		} ),
	} );
	el._ttGrid = grid;

	// Row selection is not something the grid does, so it is delegated here:
	// one listener on the table, mapped back to the grid's row objects.
	grid.control.addEventListener( "click", ( evt ) => {
		const tr = evt.target.closest( "tr" );
		const hit = tr && grid.rows.find( r => r.el === tr && r.rowData );
		if( !hit ) return;
		selectRow( el, grid, hit.rowData );
		if( onSelect ) onSelect( hit.rowData );
		el.dispatchEvent( new CustomEvent( "tt-row", { bubbles: true, detail: { row: hit.rowData } } ) );
	} );

	// Double-click: "open this row".  The table does not know what opening
	// means; it announces the row (and what it knows: the rows, the columns,
	// the ctx to act through) and whoever registered the columns' cell types
	// decides -- the sessions plugin opens its game editor on it.
	grid.control.addEventListener( "dblclick", ( evt ) => {
		const tr = evt.target.closest( "tr" );
		const hit = tr && grid.rows.find( r => r.el === tr && r.rowData );
		if( !hit ) return;
		evt.preventDefault();
		el.dispatchEvent( new CustomEvent( "tt-row-open",
			{ bubbles: true, detail: { row: hit.rowData, rows, columns, ctx } } ) );
	} );

	// Typing in a filter cell: the grid has already narrowed its rows locally;
	// a caller may also want to re-query (a player search against the server).
	if( opts.onFilter ) grid.on( "filter", opts.onFilter );

	return grid;
}

/** Mark one data row selected; the class is what the stylesheet highlights. */
function selectRow( el, grid, rowData ) {
	for( const r of grid.rows ) r.el.classList.toggle( "tt-row-selected", r.rowData === rowData );
}

/** The grid's filter row as the source's `filters` input: [ {field, value} ]. */
function filtersOf( grid ) {
	return grid.filters.map( f => ( { field: f.field, value: f.value } ) );
}

/** Restore filter text across a re-render, since the grid is rebuilt per query. */
function keepFilters( el, grid ) {
	const saved = el._ttFilterText || {};
	for( const input of grid.control.querySelectorAll( "input[class^='data-grid-filter-input']" ) ) {
		const name = input.placeholder;
		if( saved[ name ] ) input.value = saved[ name ];
		input.addEventListener( "input", () => { saved[ name ] = input.value; el._ttFilterText = saved; } );
	}
	if( Object.keys( saved ).length ) grid.applyFilter();
}

let filterTimer = null;

async function refresh( el, inst ) {
	const protocol = getProtocol();
	if( !protocol ) { el.textContent = "(no connection)"; return; }

	// Name the control, never the query -- same rule as invoking an action.
	// The document's current inputs ride along so a source can be scoped by
	// another control's selection; the server keeps only the keys it declares.
	const reply = await protocol.query( inst.id, { ...gatherInputs(), ...( el._ttFilter || {} ) } );
	if( !reply.ok ) { el.textContent = `(${reply.error})`; return; }

	// A document may pick and relabel columns; the source still knows their types.
	const typed = new Map( ( reply.columns || [] ).map( c => [ c.key, c ] ) );
	const columns = ( inst.props.columns && inst.props.columns.length )
		? inst.props.columns.map( c => ( { ...typed.get( c.key ), ...c } ) ) : reply.columns;

	const name = inst.props.inputName;
	const key  = inst.props.inputKey || "Id";
	const grid = renderRows( el, columns, reply.rows, name ? ( row ) => {
		setInput( name, key in row ? row[ key ] : row );
	} : null, {
		filter:   !!inst.props.filter,
		sortable: inst.props.sortable !== false,
		// A cell renderer that changes something goes through the table's own
		// action, with the same rule as a button: only the control id and the
		// press-time input cross the wire; the server reads the action from
		// the document and checks the control's security.
		invoke: async ( input, slot ) => {
			const name = slot ? ( inst.props.actions || {} )[ slot ] : inst.props.action;
			if( !name || name === "none" ) return { ok: false, error: slot ? `table has no '${slot}' action` : "table has no action" };
			const reply = await invoke( inst, { element: el, protocol, slot, input: { ...gatherInputs(), ...input } } );
			el.dispatchEvent( new CustomEvent( "tt-invoked", { bubbles: true, detail: { control: inst, reply } } ) );
			return reply;
		},
		// serverFilter: the filter row also re-queries, so a source that only
		// returned a page can search the rest.  Debounced; the grid's local
		// narrowing has already happened, so the page never waits on the wire.
		onFilter: inst.props.filter && inst.props.serverFilter ? ( ev ) => {
			el._ttFilter = { filters: filtersOf( ev.grid ) };
			clearTimeout( filterTimer );
			filterTimer = setTimeout( () => refresh( el, inst ), 250 );
		} : null,
	} );
	keepFilters( el, grid );

	if( name ) {
		// The rows changed under a selection; re-select if it survived, else
		// clear it so a button cannot act on a row that is no longer shown.
		const current = inputValue( name );
		const row = current === undefined ? null
			: reply.rows.find( r => String( r[ key ] ) === String( current ) );
		if( !row ) { if( current !== undefined ) setInput( name, undefined ); }
		else selectRow( el, grid, row );
	}
}

function inputValue( name ) { return gatherInputs()[ name ]; }

/** Refresh while shown: after any action, on a broadcast, or on a dependency. */
function listen( el, inst ) {
	unlisten( el );
	const again = () => refresh( el, inst );
	el._ttOnInvoked = ( e ) => { if( e.detail && e.detail.reply && e.detail.reply.ok !== false ) again(); };
	el._ttOnRefresh = again;
	document.addEventListener( "tt-invoked", el._ttOnInvoked );
	document.addEventListener( "tt-refresh", el._ttOnRefresh );
	const deps = String( inst.props.dependsOn || "" ).split( "," ).map( s => s.trim() ).filter( Boolean );
	if( deps.length )
		el._ttUnwatch = watchInputs( ( name ) => { if( deps.includes( name ) ) again(); } );
}

function unlisten( el ) {
	if( el._ttOnInvoked ) document.removeEventListener( "tt-invoked", el._ttOnInvoked );
	if( el._ttOnRefresh ) document.removeEventListener( "tt-refresh", el._ttOnRefresh );
	if( el._ttUnwatch ) el._ttUnwatch();
	el._ttOnInvoked = el._ttOnRefresh = el._ttUnwatch = null;
	if( el._ttTimer ) { clearInterval( el._ttTimer ); el._ttTimer = null; }
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
		sortable:   { type: PropType.Bool,   label: "Click headers to sort", default: true },
		filter:     { type: PropType.Bool,   label: "Per-column filter row", default: false },
		serverFilter: { type: PropType.Bool, label: "Filter row also re-queries the source",
		              default: false, hint: "sends filters:[{field,value}] as input" },
		action:     { type: PropType.Action, label: "Cell action", default: "none",
		              hint: "fired by a cell renderer that edits (a pattern picker)" },
		actionArgs: { type: PropType.Args,   label: "Action settings", default: null },
		actions:    { type: PropType.Args,   label: "Named cell actions (slot: action)", default: null,
		              hint: "a cell renderer names the slot it fires, e.g. details / save" },
		inputName:  { type: PropType.String, label: "Selection input name", default: "",
		              hint: "picking a row publishes its key under this name" },
		inputKey:   { type: PropType.String, label: "Selection key column", default: "Id" },
		dependsOn:  { type: PropType.String, label: "Re-query when these inputs change",
		              default: "", hint: "comma-separated input names" },
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
		listen( el, inst );
		const ms = Number( inst.props.refreshMs ) || 0;
		if( ms >= 250 ) el._ttTimer = setInterval( () => refresh( el, inst ), ms );
	},

	onHide( el ) { unlisten( el ); },

	// Querying while the designer drags things around is pure noise.
	onEditBegin( el ) { unlisten( el ); },

	onEditEnd( el, inst ) { refresh( el, inst ); listen( el, inst ); },

	dispose( el ) { unlisten( el ); },
} );
