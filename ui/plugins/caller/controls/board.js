/**
 * @fileoverview The call screen's pieces: the flashboard, the rolling balls,
 * the countdown ring and the pattern block.
 *
 * Each is a thin control over a component in ../lib: the component draws and
 * the control wires it to the caller state and the proxy.  A board marks on
 * the proxy's `call`, never on its own click, so every board in the room
 * shows the same thing.
 */

import { registerControl } from "../../../core/registry.js";
import { PropType } from "../../../core/properties.js";
import { Flashboard } from "../lib/flashboard.js";
import { BallView } from "../lib/ballView.js";
import { RingTimer } from "../lib/ringTimer.js";
import { state, caller, modules, patternServiceOrigin, isDesigner } from "../lib/connection.js";
import { whenReady, listen, detach, gameSize, gameMasks } from "../lib/bind.js";

/** the boards on screen, so the ball view can fly a ball off the right tile */
const boards = new Set();

/** where ball n is on the first displayed board, in client pixels; else null */
export function boardPosition( n ) {
	for( const fb of boards ) {
		const pos = fb.ballPosition( n );
		if( pos ) return pos;
	}
	return null;
}

// -- caller/Flashboard ------------------------------------------------------------

registerControl( "caller/Flashboard", {
	description: "The 75-ball board; click a ball to call it, a called ball to uncall it.",
	properties: {
		showLetters: { type: PropType.Bool, label: "B-I-N-G-O letters", default: true },
		readOnly:    { type: PropType.Bool, label: "Read only", default: false },
		security:    { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const host = document.createElement( "div" );
		host.className = "ttc-board-host";
		host._ttcLetters = null;
		build( host, inst );
		whenReady( host, ( ctx, box ) => {
			const paint = () => host._ttcBoard.setMarks( state.order, state.lastBall );
			paint();
			listen( box, state, "game", paint );
			listen( box, state, "call",   ( ball, last ) => { host._ttcBoard.mark( ball ); host._ttcBoard.setLast( last ); } );
			listen( box, state, "uncall", ( ball, last ) => { host._ttcBoard.unmark( ball ); host._ttcBoard.setLast( last ); } );
			listen( box, state, "connection", ( status ) => { if( status === "offline" ) host._ttcBoard.reset(); } );
		} );
		return host;
	},

	update( host, inst ) {
		if( host._ttcLetters !== !!inst.props.showLetters ) build( host, inst );
		host._ttcBoard.locked = !!inst.props.readOnly || isDesigner();
	},

	dispose( host ) {
		if( host._ttcBoard ) boards.delete( host._ttcBoard );
		detach( host );
	},
} );

function build( host, inst ) {
	if( host._ttcBoard ) { boards.delete( host._ttcBoard ); host._ttcBoard.el.remove(); }
	const fb = new Flashboard( { showLetters: !!inst.props.showLetters, locked: !!inst.props.readOnly } );
	fb.onCall = ( n ) => caller.call( n );
	fb.onUncall = ( n ) => caller.uncall( n );
	host.appendChild( fb.el );
	host._ttcBoard = fb;
	host._ttcLetters = !!inst.props.showLetters;
	boards.add( fb );
	if( state.order.length ) fb.setMarks( state.order, state.lastBall );
}

// -- caller/Ball View -------------------------------------------------------------

registerControl( "caller/Ball View", {
	description: "The last ball called, large, with the balls before it racked in order.",
	properties: {
		security: { type: PropType.Security, label: "Security" },
	},

	create() {
		const host = document.createElement( "div" );
		host.className = "ttc-ball-host";
		whenReady( host, async ( ctx, box ) => {
			if( !modules.origin || isDesigner() ) { host.textContent = "(ball view)"; return; }
			let mod;
			try { mod = await import( modules.origin + "/common/bingo/ballView/ballView.mjs" ); }
			catch( err ) { host.textContent = "(ball view unavailable)"; console.error( "caller: ballView.mjs:", err ); return; }
			if( box.disposed ) return;
			const view = new BallView( mod );
			host._ttcView = view;
			host.appendChild( view.canvas );
			view.setBalls( state.order );
			listen( box, state, "game", () => view.setBalls( state.order ) );
			listen( box, state, "call", ( ball, last ) => view.setLastBall( last, boardPosition( last ) ) );
			listen( box, state, "uncall", ( ball, last ) => { view.uncall( ball, boardPosition( ball ) ); view.setLastBall( last ); } );
			listen( box, state, "connection", ( status ) => { if( status === "offline" ) view.clear(); } );
		} );
		return host;
	},

	dispose( host ) { detach( host ); },
} );

// -- caller/Ring Timer ------------------------------------------------------------

registerControl( "caller/Ring Timer", {
	description: "Countdown between calls; starts on every call, click to pick the seconds.",
	properties: {
		seconds:   { type: PropType.Number, label: "Seconds", default: 11 },
		autoStart: { type: PropType.Bool,   label: "Start on each call", default: true },
		sound:     { type: PropType.String, label: "Sound (on the proxy)", default: "/common/sounds/Ding.wav" },
		security:  { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const timer = new RingTimer( { seconds: inst.props.seconds } );
		const el = timer.el;
		el._ttcTimer = timer;
		whenReady( el, ( ctx, box ) => {
			if( inst.props.sound && modules.origin ) timer.setSound( modules.origin + inst.props.sound );
			listen( box, state, "call", () => { if( inst.props.autoStart ) timer.start(); } );
			listen( box, state, "endGame", () => timer.stop() );
			listen( box, state, "endSession", () => timer.stop() );
		} );
		return el;
	},

	update( el, inst ) {
		el._ttcTimer.seconds = Number( inst.props.seconds ) || 11;
		if( modules.origin ) el._ttcTimer.setSound( inst.props.sound ? modules.origin + inst.props.sound : "" );
	},

	onEditBegin( el ) { el._ttcTimer.stop(); },
	dispose( el ) { el._ttcTimer.dispose(); detach( el ); },
} );

// -- caller/Pattern ---------------------------------------------------------------

registerControl( "caller/Pattern", {
	description: "The current game's pattern; click to change it through the pattern editor.",
	properties: {
		clickToChange: { type: PropType.Bool, label: "Click opens the picker", default: true },
		security:      { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const host = document.createElement( "div" );
		host.className = "ttc-pattern";
		host.title = "";
		whenReady( host, ( ctx, box ) => {
			if( !modules.PatternDisplay ) { host.textContent = "(pattern)"; return; }
			const display = new modules.PatternDisplay( host, 5, [] );
			display.animated = 500;
			host._ttcDisplay = display;
			const paint = ( game ) => {
				game = game === undefined ? state.game : game;
				if( !game ) { display.setBits( 5, [] ); host.title = ""; return; }
				display.setBits( gameSize( game ), gameMasks( game ) );
				host.title = ( game.pattern && game.pattern.Name ) || "";
			};
			paint();
			listen( box, state, "game", ( game ) => paint( game ) );
			listen( box, state, "pattern", ( game, index ) => { if( index === state.gameIndex ) paint( game ); } );
		} );
		host.addEventListener( "click", async () => {
			if( !inst.props.clickToChange || isDesigner() ) return;
			const game = state.game;
			if( !game ) return;
			try {
				const picker = await import( patternServiceOrigin() + "/patternPicker.js" );
				// the proxy's game carries GameCardType; only a numeric id is a type the editor can lock to
				const typeId = Number( game.gameCardTypeId || game.GameCardTypeId || game.GameCardType ) || 0;
				const picked = await picker.pickPattern( {
					patternId: game.pattern && game.pattern.Id,
					gameCardTypeId: typeId || undefined,
					lockType: !!typeId,
				} );
				if( picked && picked.pattern ) caller.changePattern( picked.pattern );
			} catch( err ) {
				if( err && err.message !== "cancelled" ) console.error( "caller: pattern picker:", err );
			}
		} );
		return host;
	},

	dispose( host ) { detach( host ); },
} );
