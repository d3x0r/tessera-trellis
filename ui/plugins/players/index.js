/**
 * @fileoverview Example plugin, client half.
 *
 * A plugin's client half registers controls, client actions and variables --
 * the same registration calls the built-in modules use, with no wrapper.  The
 * server lists it, both entry points import it before rendering, and that is
 * the whole mechanism.
 */

import { registerControl } from "../../core/registry.js";
import { PropType } from "../../core/properties.js";
import { renderRows } from "../../controls/table.js";

let protocolModule;
export function useProtocol( mod ) { protocolModule = mod; }

registerControl( "data/Player Search", {
	description: "Search box over the players source.",
	properties: {
		source:     { type: PropType.Choice, label: "Source", default: "players" },
		sourceArgs: { type: PropType.Args,   label: "Source settings", default: null },
		placeholder:{ type: PropType.String, label: "Placeholder", default: "search name..." },
		security:   { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const el = document.createElement( "div" );
		el.className = "tt-search";

		const box = document.createElement( "input" );
		box.className = "tt-search-box";
		box.type = "search";

		const results = document.createElement( "div" );
		results.className = "tt-table-host tt-search-results";
		results.textContent = "(type to search)";

		el.append( box, results );

		let timer = null;
		const run = async () => {
			const protocol = protocolModule && protocolModule.protocol;
			if( !protocol ) { results.textContent = "(no connection)"; return; }
			// Name the control, not the query; the filter is press-time input.
			const reply = await protocol.query( inst.id, { name: box.value } );
			if( !reply.ok ) { results.textContent = `(${reply.error})`; return; }
			renderRows( results, reply.columns, reply.rows );
		};

		box.addEventListener( "input", () => {
			clearTimeout( timer );
			timer = setTimeout( run, 150 );
		} );

		el._ttRun = run;
		return el;
	},

	update( el, inst ) {
		el.querySelector( ".tt-search-box" ).placeholder = inst.props.placeholder;
	},

	onShow( el ) { el._ttRun(); },
} );
