/**
 * @fileoverview The caller's connection to the sideplayr game proxy.
 *
 * One socket per window, opened from the browser exactly as the old caller
 * page opens it: a "GameProxy" websocket with ?caller=1, authorised either
 * through the proxy's employee login (the /common/login form, hosted here in
 * an overlay) or as a self-authorising "service:" uid for development.
 *
 * Everything the caller needs from the proxy's tree -- JSOX, the ball queue,
 * the Pattern class, the login form -- is imported CROSS-ORIGIN from the proxy
 * itself, the way the sessions plugin imports the pattern picker from the
 * pattern service.  Those modules import their own dependencies by absolute
 * path (/node_modules/..., /common/...), which resolve against the proxy's
 * origin because that is where the importing module came from, so the whole
 * graph loads from one place and this service serves none of it.
 *
 * Where the proxy is comes from the caller/Connection control's properties;
 * without one (a page opened on a dev box) it is this host on port 8087.
 * Nothing connects until the first control asks, and that ask is deferred a
 * tick so the Connection control -- which lives in the shared layer and is
 * built AFTER the page -- gets to configure the origin first.
 *
 * The designer never connects.  Opening a socket with ?caller=1 claims the
 * caller role in the room, and arranging a layout is not calling a game.
 */

import { CallerState } from "./state.js";

const DEFAULT_PORT = 8087;
const RECONNECT_MS = 5000;

const settings = {
	service: "",          // http(s) origin of the game proxy; "" = this host:8087
	patternService: "",   // http(s) origin of the pattern editor service
	auth: "login",        // "login" | "service"
};

export const state = new CallerState();

/** the modules loaded from the proxy, once ready() resolves */
export const modules = {
	origin: null,
	JSOX: null,
	login: null,        // /common/login/login.js default export (null in service auth)
	popups: null,       // the proxy's popups, for the login form (null in service auth)
	makeQueue: null,
	Pattern: null,
	PatternDisplay: null,
};

let starting = null;
let ws = null;
let closedOnPurpose = false;
const designer = /editor\.html$/.test( location.pathname );

/** @param {{service?:string, patternService?:string, auth?:string}} opts */
export function configure( opts ) {
	if( !opts ) return;
	const before = serviceOrigin();
	if( opts.service !== undefined )        settings.service = String( opts.service || "" ).trim();
	if( opts.patternService !== undefined ) settings.patternService = String( opts.patternService || "" ).trim();
	if( opts.auth !== undefined && opts.auth ) settings.auth = String( opts.auth );
	if( starting && before !== serviceOrigin() )
		console.warn( "caller: the game proxy origin changed after connecting; reload to apply", serviceOrigin() );
}

export function serviceOrigin() {
	return trimSlash( settings.service ) || ( location.protocol + "//" + location.hostname + ":" + DEFAULT_PORT );
}

export function patternServiceOrigin() {
	return trimSlash( settings.patternService ) || ( location.protocol + "//" + location.hostname + ":8085" );
}

export function authMode() { return settings.auth; }
export function isDesigner() { return designer; }

function trimSlash( s ) { return s ? s.replace( /\/+$/, "" ) : s; }

/**
 * The live connection, started on first call.
 * @returns {Promise<{state:CallerState, modules:object, caller:object}>}
 */
export function ready() {
	if( !starting )
		starting = new Promise( resolve => setTimeout( resolve, 0 ) ).then( start );
	return starting;
}

async function start() {
	const origin = serviceOrigin();
	modules.origin = origin;
	if( designer ) {
		state.setConnection( "designer" );
		return { state, modules, caller };
	}
	state.setConnection( "loading" );
	try {
		const [ jsoxMod, queueMod, patternMod, displayMod ] = await Promise.all( [
			import( origin + "/node_modules/jsox/lib/jsox.mjs" ),
			import( origin + "/common/bingo/BallQueue.mjs" ),
			import( origin + "/common/bingo/Patterns.mjs" ),
			import( origin + "/common/bingo/SimplePatternDisplay.js" ),
		] );
		modules.JSOX = jsoxMod.JSOX;
		modules.makeQueue = queueMod.makeQueue;
		modules.Pattern = patternMod.Pattern;
		modules.PatternDisplay = displayMod.PatternDisplay;
		// patterns arrive as JSOX class instances (with Expand()) only once the
		// class is registered, the same call the old caller makes at boot
		if( modules.Pattern && modules.Pattern.setJSOX ) modules.Pattern.setJSOX( modules.JSOX );
		state.setQueue( modules.makeQueue( "caller" ) );
	} catch( err ) {
		console.error( "caller: could not load the game proxy's modules from", origin, err );
		state.lastError = "could not reach " + origin;
		state.setConnection( "offline" );
		state.emit( "error", state.lastError );
		return { state, modules, caller };
	}

	if( settings.auth !== "service" ) await setupLogin( origin );
	connect( origin );
	return { state, modules, caller };
}

// -- the employee login --------------------------------------------------------

let loginOverlay = null;

/**
 * Host the proxy's own login form over the page until an employee is logged
 * in, then hand its authorisation to the game socket (login.auth).  Same
 * pieces the old caller page uses; the form's script finds its inputs through
 * the proxy's popups, which is why that popups is the one that fills it.
 */
async function setupLogin( origin ) {
	try {
		const [ loginMod, popupsMod ] = await Promise.all( [
			import( origin + "/common/login/login.js" ),
			import( origin + "/node_modules/@d3x0r/popups/popups.mjs" ),
		] );
		modules.login = loginMod.default;
		modules.popups = popupsMod.popups;
	} catch( err ) {
		console.error( "caller: could not load the login form from", origin, err );
		return;
	}
	const login = modules.login;

	loginOverlay = document.createElement( "div" );
	loginOverlay.className = "ttc-login-overlay";
	document.body.appendChild( loginOverlay );
	try { await modules.popups.fillFromURL( loginOverlay, origin + "/common/login/login.html" ); }
	catch( err ) { console.error( "caller: login form did not load:", err ); }

	login.on( "connect", () => {
		// resume a session the browser still holds a token for
		login.loginAs( null, "ManaulRngToken" ).catch( () => {} );
	} );
	login.on( "login", ( yesno ) => {
		if( yesno && yesno.success ) { hideLogin(); state.emit( "login", yesno ); return; }
		if( !yesno ) return;
		state.lastError = yesno.locked ? "Account locked"
		                : yesno.tries ? `Wrong credentials, ${yesno.tries} tries left`
		                : "Wrong credentials";
		state.emit( "error", state.lastError );
	} );
	login.on( "error", ( err ) => { state.lastError = String( err ); state.emit( "error", state.lastError ); } );
	login.on( "pinFail", ( err ) => { state.lastError = String( err ); state.emit( "error", state.lastError ); } );
	login.on( "close", ( info ) => {
		if( info && info.code === 1234 ) return;   // deliberate close: do not re-prompt
		showLogin();
	} );
	login.connect();
}

function showLogin() { if( loginOverlay ) loginOverlay.hidden = false; }
function hideLogin() { if( loginOverlay ) loginOverlay.hidden = true; }

// -- the game socket -----------------------------------------------------------------

function connect( origin ) {
	if( ws ) return;
	closedOnPurpose = false;
	const url = origin.replace( /^http/, "ws" ) + "/?caller=1";
	state.setConnection( "connecting" );
	let sock;
	try { sock = new WebSocket( url, "GameProxy" ); }
	catch( err ) {
		console.error( "caller: socket refused:", err );
		state.setConnection( "offline" );
		setTimeout( () => connect( origin ), RECONNECT_MS );
		return;
	}
	ws = sock;

	sock.onopen = () => {
		state.setConnection( "open" );
		const login = modules.login;
		const uid = ( settings.auth === "service" || !login )
			? "service:" + Math.random().toString( 36 ).slice( 2 )
			: login.auth( sock );
		// an employee login authorises this socket through the login socket;
		// a service uid is self-authorising and has to be sent from here
		if( uid && uid.startsWith( "service:" ) ) send( { op: "auth", uid } );
	};
	sock.onmessage = ( evt ) => {
		let msg;
		try { msg = modules.JSOX.parse( evt.data ); }
		catch( err ) { console.warn( "caller: unparseable message", evt.data ); return; }
		if( !state.receive( msg ) ) console.log( "caller: unhandled message", msg );
	};
	sock.onclose = ( evt ) => {
		if( ws === sock ) ws = null;
		if( modules.login ) modules.login.deauth( sock );
		state.setConnection( "offline" );
		if( closedOnPurpose ) return;
		// 1000 is the proxy asking us to come back now (a role change)
		setTimeout( () => connect( origin ), evt.code === 1000 ? 0 : RECONNECT_MS );
	};
	sock.onerror = () => { /* onclose follows and reconnects */ };
}

function send( msg ) {
	if( !ws || ws.readyState !== WebSocket.OPEN ) {
		state.lastError = "not connected";
		state.emit( "error", state.lastError );
		return false;
	}
	ws.send( modules.JSOX.stringify( msg ) );
	return true;
}

/** the game that is up, as the proxy identifies it, or null */
function currentGame() {
	const game = state.game;
	return game || null;
}

// -- what a caller can ask for ---------------------------------------------------------

export const caller = {
	send,
	playSession( session ) {
		const id = session && ( session.id !== undefined ? session.id : session );
		if( id === undefined || id === null ) return false;
		return send( { op: "playSession", id } );
	},
	closeSession() { return send( { op: "endSession" } ); },

	/** make a game current without starting it (paints its board) */
	selectGame( index ) { return state.selectGame( index ); },

	startGame() {
		const game = currentGame();
		if( !game ) return false;
		return send( { op: "startGame", id: game.id } );
	},
	resumeGame() {
		const game = currentGame();
		if( !game ) return false;
		return send( { op: "reopenGame", id: game.id } );
	},
	endGame()    { return send( { op: "endGame" } ); },
	refundGame() { return send( { op: "refundGame" } ); },
	resetGame() {
		const game = currentGame();
		if( !game ) return false;
		return send( { op: "reset", id: game.id } );
	},
	/** ask for the winners; the proxy answers with a verify message */
	validate()   { return send( { op: "getWinners" } ); },
	/** leave verify mode (tells the floor and the boards too) */
	verifyGame( enable ) { return send( { op: "verifyGame", enable: !!enable } ); },

	call( ball )   { return send( { op: "call", ball: Number( ball ) } ); },
	uncall( ball ) { return send( { op: "uncall", ball: Number( ball ) } ); },
	monitorBall( n ) { return send( { op: "monitor_ball", back: Math.floor( ( n - 1 ) / 15 ) + 1, front: n } ); },

	/**
	 * Change the current game's pattern.  The proxy looks the pattern up by
	 * Id on the pattern service, so the Id is what matters here.
	 */
	changePattern( pattern ) {
		const game = currentGame();
		if( !game || !pattern ) return false;
		const masks = pattern.composite_masks || pattern.masks || [];
		return send( { op: "changePattern", game: game.id,
			pattern: { Id: pattern.Id, Name: pattern.Name || pattern.PatternType || "", value: masks[ 0 ] } } );
	},

	showCard( card, player, cardset ) { return send( { op: "showCard", card, player, cardset } ); },
	addCard( card, position, player, cardset, pack_id ) {
		return send( { op: "addCard", card, player, position, cardset, pack_id } );
	},
	addWinner( card ) { return send( { op: "addWinner", card } ); },

	/** for a Quit that should not reconnect */
	disconnect() {
		closedOnPurpose = true;
		if( ws ) ws.close( 1001, "quit" );
	},
};
