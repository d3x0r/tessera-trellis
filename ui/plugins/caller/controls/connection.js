/**
 * @fileoverview caller/Connection: where the game proxy is, and how we are.
 *
 * The one control a caller document must carry.  Its properties are the
 * deployment facts -- the proxy's origin, the pattern service, whether to
 * log an employee in or connect as a service -- and it shows the state of the
 * socket as a light and a line of text, with the last refusal or notice from
 * the proxy for a few seconds.
 *
 * It also defines the display variables a document can put in any label:
 *
 *   %Caller Connection   offline / connecting / ready in Bingo
 *   %Caller Session      the session in play
 *   %Caller Game         the game that is up
 *   %Caller Game Status  Ready / In play / Closed
 *   %Caller Ball Count   balls called so far
 *   %Caller Last Ball    the last ball
 *   %Caller Room         the room this station is bound to
 *   %Caller Presence     who else is calling here
 */

import { registerControl } from "../../../core/registry.js";
import { PropType } from "../../../core/properties.js";
import { defineVariable, setVariable } from "../../../core/variables.js";
import { state, configure, serviceOrigin, isDesigner } from "../lib/connection.js";
import { callerName } from "../lib/state.js";
import { whenReady, listen, detach } from "../lib/bind.js";

// -- variables: live from the moment the plugin loads ------------------------------

defineVariable( "Caller Connection", "offline" );
defineVariable( "Caller Session", "" );
defineVariable( "Caller Game", "" );
defineVariable( "Caller Game Status", "" );
defineVariable( "Caller Ball Count", "0" );
defineVariable( "Caller Last Ball", "" );
defineVariable( "Caller Room", "" );
defineVariable( "Caller Presence", "" );

function connectionText() {
	if( state.connection === "designer" ) return "designer (not connected)";
	if( state.connection === "ready" ) return "ready" + ( state.room ? " in " + state.room : "" );
	return state.connection;
}

function describeSession() {
	const s = state.session;
	if( !s ) return "";
	const id = s.session;
	const row = state.sessions.find( x => x.id === id );
	return ( row && row.name ) ? `#${id} ${row.name}` : `#${id}`;
}

state.on( "connection", () => { setVariable( "Caller Connection", connectionText() ); setVariable( "Caller Room", state.room || "" ); } );
state.on( "whoami", () => { setVariable( "Caller Connection", connectionText() ); setVariable( "Caller Room", state.room || "" ); } );
state.on( "session", () => setVariable( "Caller Session", describeSession() ) );
state.on( "sessions", () => setVariable( "Caller Session", describeSession() ) );
state.on( "endSession", () => setVariable( "Caller Session", "" ) );
state.on( "game", ( game ) => {
	setVariable( "Caller Game", game ? String( game.name || "" ) : "" );
	setVariable( "Caller Game Status", state.gameStatus );
	setVariable( "Caller Ball Count", String( state.order.length ) );
	setVariable( "Caller Last Ball", state.lastBall ? String( state.lastBall ) : "" );
} );
state.on( "playGame", () => setVariable( "Caller Game Status", state.gameStatus ) );
state.on( "endGame", () => setVariable( "Caller Game Status", state.gameStatus ) );
for( const ev of [ "call", "uncall" ] )
	state.on( ev, () => {
		setVariable( "Caller Ball Count", String( state.order.length ) );
		setVariable( "Caller Last Ball", state.lastBall ? String( state.lastBall ) : "" );
	} );
state.on( "presence", ( callers ) => setVariable( "Caller Presence", ( callers || [] ).map( callerName ).join( ", " ) ) );

// -- the control ---------------------------------------------------------------------

registerControl( "caller/Connection", {
	description: "Where the game proxy is, and whether this station is connected to it.",
	properties: {
		service:        { type: PropType.String, label: "Game proxy (http origin)", default: "",
		                  hint: "blank: this host on port 8087" },
		patternService: { type: PropType.String, label: "Pattern service (http origin)", default: "",
		                  hint: "blank: this host on port 8085" },
		auth:           { type: PropType.Choice, label: "Authorise as", default: "login",
		                  choices: [ "login", "service" ] },
		showText:       { type: PropType.Bool, label: "Show status text", default: true },
		security:       { type: PropType.Security, label: "Security" },
	},

	create() {
		const host = document.createElement( "div" );
		host.className = "ttc-connection";
		const light = document.createElement( "span" );
		light.className = "ttc-connection-light";
		const text = document.createElement( "span" );
		text.className = "ttc-connection-text";
		const flash = document.createElement( "span" );
		flash.className = "ttc-connection-flash";
		flash.hidden = true;
		host.append( light, text, flash );
		host._ttcText = text;

		let flashTimer = null;
		const say = ( message, kind ) => {
			flash.textContent = message;
			flash.className = "ttc-connection-flash " + kind;
			flash.hidden = false;
			clearTimeout( flashTimer );
			flashTimer = setTimeout( () => { flash.hidden = true; }, 6000 );
		};

		const paint = () => {
			host.dataset.state = state.connection;
			text.textContent = connectionText() + ( isDesigner() ? "" : " · " + serviceOrigin() );
		};
		paint();
		whenReady( host, ( ctx, box ) => {
			paint();
			listen( box, state, "connection", paint );
			listen( box, state, "whoami", paint );
			listen( box, state, "error", ( message ) => say( message, "error" ) );
			listen( box, state, "notice", ( message ) => say( message, "notice" ) );
		} );
		return host;
	},

	update( host, inst ) {
		configure( { service: inst.props.service, patternService: inst.props.patternService, auth: inst.props.auth } );
		host._ttcText.hidden = !inst.props.showText;
		host._ttcText.textContent = connectionText() + ( isDesigner() ? "" : " · " + serviceOrigin() );
	},

	dispose( host ) { detach( host ); },
} );
