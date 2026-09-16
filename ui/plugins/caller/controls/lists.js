/**
 * @fileoverview Lists off the live socket: the sessions the proxy offers, the
 * games of the session in play, and who else is calling in the room.
 *
 * These are controls rather than data/Table over a source because the rows
 * come down the caller's own socket as the room changes, not from a query
 * this service could run.
 */

import { registerControl } from "../../../core/registry.js";
import { PropType } from "../../../core/properties.js";
import { state, caller, modules, isDesigner } from "../lib/connection.js";
import { callerName } from "../lib/state.js";
import { whenReady, listen, detach, navigate, gameSize, gameMasks } from "../lib/bind.js";

function text( cls, value ) {
	const el = document.createElement( "span" );
	el.className = cls;
	el.textContent = value === undefined || value === null ? "" : String( value );
	return el;
}

function when( d ) {
	if( !d ) return "";
	if( d instanceof Date ) return isNaN( d ) ? "" : d.toLocaleDateString();
	const parsed = new Date( d );
	return isNaN( parsed ) ? String( d ) : parsed.toLocaleDateString();
}

// -- caller/Sessions --------------------------------------------------------------

registerControl( "caller/Sessions", {
	description: "The sessions the room can play; pick one to play it.",
	properties: {
		nextPage: { type: PropType.Page, label: "After picking, go to", default: "" },
		security: { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const host = document.createElement( "div" );
		host.className = "ttc-tiles ttc-sessions";
		host.textContent = "(no sessions)";
		whenReady( host, ( ctx, box ) => {
			const render = () => {
				host.textContent = "";
				const sessions = state.sessions || [];
				if( !sessions.length ) { host.textContent = state.connection === "ready" ? "(no sessions)" : "(" + state.connection + ")"; return; }
				const current = state.session && state.session.session;
				for( const session of sessions ) {
					const tile = document.createElement( "div" );
					tile.className = "ttc-tile ttc-session-tile";
					if( current !== undefined && current !== null && session.id === current ) tile.classList.add( "current" );
					tile.append( text( "ttc-tile-name", session.name ) );
					if( session.type ) tile.append( text( "ttc-tile-type", session.type ) );
					tile.append( text( "ttc-tile-date", when( session.date ) ) );
					tile.addEventListener( "click", () => {
						if( isDesigner() ) return;
						caller.playSession( session );
					} );
					host.appendChild( tile );
				}
			};
			render();
			listen( box, state, "sessions", render );
			listen( box, state, "connection", render );
			listen( box, state, "endSession", render );
			// the room went into a session while this list was showing: move on
			listen( box, state, "session", () => {
				render();
				if( host.offsetParent !== null ) navigate( host, inst.props.nextPage );
			} );
		} );
		return host;
	},

	dispose( host ) { detach( host ); },
} );

// -- caller/Games -----------------------------------------------------------------

const STATUS_CLASS = { 2: "ready", 3: "playing", 7: "playing", 5: "closed" };

registerControl( "caller/Games", {
	description: "The games of the session in play; pick one to bring it up (a ready one also starts).",
	properties: {
		nextPage:    { type: PropType.Page, label: "After picking, go to", default: "" },
		startOnPick: { type: PropType.Bool, label: "Picking a ready game starts it", default: true },
		security:    { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const host = document.createElement( "div" );
		host.className = "ttc-tiles ttc-games";
		host.textContent = "(no session)";
		let tiles = [];

		const refresh = () => {
			tiles.forEach( ( tile, index ) => {
				const game = state.games[ index ];
				tile.classList.remove( "ready", "playing", "closed", "current" );
				if( game && STATUS_CLASS[ game.status ] ) tile.classList.add( STATUS_CLASS[ game.status ] );
				if( index === state.gameIndex ) tile.classList.add( "current" );
			} );
		};

		const render = () => {
			host.textContent = "";
			tiles = [];
			const games = state.games || [];
			if( !games.length ) { host.textContent = state.session ? "(no games)" : "(no session)"; return; }
			games.forEach( ( game, index ) => {
				const tile = document.createElement( "div" );
				tile.className = "ttc-tile ttc-game-tile";
				tile.append( text( "ttc-tile-name", game.name ) );
				const block = document.createElement( "span" );
				block.className = "ttc-tile-pattern";
				if( modules.PatternDisplay ) {
					const display = new modules.PatternDisplay( block, gameSize( game ), gameMasks( game ) );
					display.animated = 500;
					tile._ttcDisplay = display;
				}
				tile.append( block );
				tile.append( text( "ttc-tile-type", ( game.pattern && game.pattern.Name ) || "" ) );
				tile.addEventListener( "click", () => {
					if( isDesigner() ) return;
					caller.selectGame( index );
					if( inst.props.startOnPick && game.status === 2 ) caller.startGame();
					navigate( host, inst.props.nextPage );
				} );
				host.appendChild( tile );
				tiles.push( tile );
			} );
			refresh();
			scrollToCurrent();
		};

		// bring the game that is up into view
		const scrollToCurrent = () => {
			const tile = tiles[ state.gameIndex ];
			if( tile && tile.scrollIntoView ) requestAnimationFrame( () => tile.scrollIntoView( { block: "nearest" } ) );
		};

		whenReady( host, ( ctx, box ) => {
			render();
			listen( box, state, "games", render );
			listen( box, state, "endSession", render );
			listen( box, state, "connection", render );
			listen( box, state, "game", () => { refresh(); scrollToCurrent(); } );
			listen( box, state, "pattern", ( game, index ) => {
				const tile = tiles[ index ];
				if( tile && tile._ttcDisplay ) tile._ttcDisplay.setBits( gameSize( game ), gameMasks( game ) );
				if( tile ) tile.querySelector( ".ttc-tile-type" ).textContent = ( game.pattern && game.pattern.Name ) || "";
			} );
		} );
		return host;
	},

	dispose( host ) { detach( host ); },
} );

// -- caller/Presence --------------------------------------------------------------

registerControl( "caller/Presence", {
	description: "Who else is calling in this room.",
	properties: {
		title:    { type: PropType.String, label: "Heading", default: "In This Room" },
		security: { type: PropType.Security, label: "Security" },
	},

	create() {
		const host = document.createElement( "div" );
		host.className = "ttc-presence";
		const header = document.createElement( "div" );
		header.className = "ttc-presence-header";
		const details = document.createElement( "div" );
		details.className = "ttc-presence-details";
		details.textContent = "—";
		host.append( header, details );
		host._ttcHeader = header;

		const render = () => {
			const callers = state.callers || [];
			if( !callers.length ) {
				details.textContent = "—";
				details.title = "";
				host.classList.remove( "shared" );
				return;
			}
			const mine = state.me && state.me.station;
			const names = callers.map( c => {
				const name = callerName( c );
				return ( mine && c.station === mine ) ? name + " (you)" : name;
			} );
			// more than one caller is the state worth noticing
			host.classList.toggle( "shared", callers.length > 1 );
			details.textContent = names.join( ", " );
			details.title = names.join( "\n" );
		};

		whenReady( host, ( ctx, box ) => {
			render();
			listen( box, state, "whoami", render );
			listen( box, state, "presence", render );
			listen( box, state, "connection", render );
		} );
		return host;
	},

	update( host, inst ) { host._ttcHeader.textContent = inst.props.title; },
	dispose( host ) { detach( host ); },
} );
