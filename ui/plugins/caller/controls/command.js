/**
 * @fileoverview The caller's buttons.
 *
 * caller/Command is a common button whose `command` names one of the things a
 * caller can ask the proxy for (start, end, refund, validate, reset, resume,
 * close the session, wild settings).  It enables itself from the caller state
 * -- a Start button is only live while a game is ready to start -- which is
 * the one thing a stock Button wired to an action could not do.
 *
 * The same commands are also registered as CLIENT ACTIONS, so a designer who
 * would rather use a stock Button (always enabled) can wire one to
 * "caller/Start Game" from the action list.
 */

import { registerControl } from "../../../core/registry.js";
import { PropType, commonButtonProperties } from "../../../core/properties.js";
import { registerAction } from "../../../core/actions.js";
import { buildButtonFace, updateButtonFace, disposeButtonFace } from "../../../controls/button.js";
import { state, caller, ready, isDesigner } from "../lib/connection.js";
import { COMMANDS } from "../lib/state.js";
import { whenReady, listen, detach } from "../lib/bind.js";

const { action, actionArgs, nextPage, ...faceProps } = commonButtonProperties;

/** Run a caller command, asking first where the command wants it. */
export async function runCommand( name, confirmMode = "default" ) {
	const def = COMMANDS[ name ];
	if( !def ) { console.warn( "caller: no command", name ); return false; }
	if( isDesigner() ) return false;
	await ready();
	if( !state.can( name ) ) return false;
	const ask = confirmMode === "always" || ( confirmMode !== "never" && def.confirm );
	if( ask && !window.confirm( def.label + "?" ) ) return false;
	if( name === "wild" ) { showWild(); return true; }
	const fn = caller[ name ];
	if( typeof fn !== "function" ) { console.warn( "caller: command has no sender", name ); return false; }
	return fn.call( caller );
}

registerControl( "caller/Command", {
	description: "A caller button: start, end, refund, validate, reset, resume, close session, wild.",
	properties: {
		command: { type: PropType.Choice, label: "Command", default: "startGame",
		           choices: Object.keys( COMMANDS ), group: "specific" },
		confirm: { type: PropType.Choice, label: "Ask first", default: "default",
		           choices: [ "default", "always", "never" ], group: "specific" },
		...faceProps,
	},

	create( inst ) {
		const el = document.createElement( "button" );
		el.className = "tt-button ttc-command";
		el._ttFace = buildButtonFace( el );
		el.addEventListener( "click", () => runCommand( inst.props.command, inst.props.confirm ) );
		const refresh = () => { el.disabled = !state.can( inst.props.command ); };
		el._ttcRefresh = refresh;
		refresh();
		whenReady( el, ( ctx, box ) => {
			refresh();
			for( const ev of [ "game", "playGame", "endGame", "session", "endSession", "connection", "verify", "sessions" ] )
				listen( box, state, ev, refresh );
		} );
		return el;
	},

	update( el, inst ) {
		const def = COMMANDS[ inst.props.command ] || { label: inst.props.command };
		el.dataset.command = inst.props.command;
		updateButtonFace( el._ttFace,
			Object.assign( {}, inst.props, { text: inst.props.text || def.label } ),
			null, inst.page && inst.page.canvas );
		el._ttcRefresh();
	},

	dispose( el ) {
		disposeButtonFace( el._ttFace );
		detach( el );
	},
} );

for( const [ name, def ] of Object.entries( COMMANDS ) ) {
	registerAction( "caller/" + def.label, {
		where: "client",
		label: "Caller: " + def.label,
		run() { return runCommand( name, "default" ); },
	} );
}

// -- wild settings --------------------------------------------------------------------

let wildPanel = null;

const SKIP = [ "B", "I", "N", "G", "O" ];
const WILD_FLAGS = [
	[ "wild", "Wild" ], [ "doubleWild", "Double Wild" ], [ "evenOddWild", "Even/Odd" ], [ "reno", "Reno" ],
];
const ALL_FLAGS = [ ...SKIP.map( l => "ignore" + l ), ...WILD_FLAGS.map( f => f[ 0 ] ) ];

/** The wild settings over the page; toggles read and write the ball queue's wildState. */
export function showWild() {
	if( !wildPanel ) wildPanel = buildWild();
	wildPanel.refresh();
	wildPanel.hidden = false;
}

function buildWild() {
	const overlay = document.createElement( "div" );
	overlay.className = "ttc-wild-overlay";
	const panel = document.createElement( "div" );
	panel.className = "ttc-wild";
	overlay.appendChild( panel );
	overlay.addEventListener( "click", ( evt ) => { if( evt.target === overlay ) overlay.hidden = true; } );

	const toggles = [];
	function toggle( parent, caption, field ) {
		const b = document.createElement( "button" );
		b.type = "button";
		b.className = "ttc-wild-toggle";
		b.textContent = caption;
		b.addEventListener( "click", () => {
			const wild = state.wildState;
			if( !wild ) return;
			wild[ field ] = !wild[ field ];
			paint();
		} );
		const paint = () => { const wild = state.wildState; b.classList.toggle( "on", !!( wild && wild[ field ] ) ); };
		toggles.push( paint );
		parent.appendChild( b );
	}

	const skipRow = document.createElement( "div" );
	skipRow.className = "ttc-wild-row";
	const label = document.createElement( "span" );
	label.className = "ttc-wild-label";
	label.textContent = "Skip:";
	skipRow.appendChild( label );
	for( const letter of SKIP ) toggle( skipRow, letter, "ignore" + letter );
	panel.appendChild( skipRow );

	const wildRow = document.createElement( "div" );
	wildRow.className = "ttc-wild-row";
	for( const [ field, caption ] of WILD_FLAGS ) toggle( wildRow, caption, field );
	panel.appendChild( wildRow );

	const note = document.createElement( "div" );
	note.className = "ttc-wild-note";
	panel.appendChild( note );

	const actions = document.createElement( "div" );
	actions.className = "ttc-wild-row ttc-wild-actions";
	const clear = document.createElement( "button" );
	clear.type = "button";
	clear.textContent = "Clear";
	clear.addEventListener( "click", () => {
		const wild = state.wildState;
		if( wild ) for( const f of ALL_FLAGS ) wild[ f ] = false;
		overlay.refresh();
	} );
	const done = document.createElement( "button" );
	done.type = "button";
	done.textContent = "Done";
	done.addEventListener( "click", () => { overlay.hidden = true; } );
	actions.append( clear, done );
	panel.appendChild( actions );

	overlay.refresh = () => {
		note.textContent = state.wildState ? "" : "(no ball queue: connect to the game proxy first)";
		for( const paint of toggles ) paint();
	};
	overlay.hidden = true;
	document.body.appendChild( overlay );
	return overlay;
}
