/**
 * @fileoverview The caller's state, with no DOM and no socket.
 *
 * Everything the caller screens show is derived from the messages the game
 * proxy sends a caller connection, so this holds exactly that: the session
 * list, the session in play with its games, which game is up, the balls that
 * have been called, who else is in the room, and whether winners are being
 * verified.  `receive( msg )` applies one proxy message; `can( command )`
 * says which caller commands make sense right now, which is what enables and
 * disables the buttons.
 *
 * Pure on purpose: tt-caller-test.mjs drives it in node with raw messages,
 * and every control subscribes to it instead of to the socket, so a control
 * never has to know a message shape.  The socket half is lib/connection.js.
 *
 * Game status codes, as the proxy reports them:
 *   2  ready to play (green)     3, 7  in play (yellow)     5  closed (red)
 */

const IN_PLAY = new Set( [ 3, 7 ] );

/** Commands a caller screen can issue, and the state each needs. */
export const COMMANDS = {
	startGame:    { label: "Start Game",    confirm: false },
	resumeGame:   { label: "Resume Game",   confirm: true },
	endGame:      { label: "End Game",      confirm: false },
	refundGame:   { label: "Refund",        confirm: true },
	validate:     { label: "Validate",      confirm: false },
	resetGame:    { label: "Reset Game",    confirm: true },
	closeSession: { label: "Close Session", confirm: true },
	wild:         { label: "Wild",          confirm: false },
};

export class CallerState {
	/** socket state: "offline" | "connecting" | "open" | "ready" (authorised, sessions received) */
	connection = "offline";
	/** last error the proxy refused a command with, and the last notice it sent */
	lastError = null;
	lastNotice = null;

	sessions = [];
	config = null;

	/** the playSession message, whole: { session, games, cardsets, noPaperGames, by } */
	session = null;
	games = [];
	/** index into games of the game that is up (selected or in play); -1 for none */
	gameIndex = -1;
	inPlay = false;

	/** balls marked for the game that is up, and the order they were called */
	marks = new Set();
	order = [];
	lastBall = 0;

	/** winners being verified: the verify payload, `true` while fetching, or null */
	verifying = null;
	winners = [];

	me = null;
	room = null;
	callers = [];

	/** an optional dedup/wild queue (common/bingo/BallQueue); see setQueue() */
	queue = null;

	#handlers = new Map();

	// -- events ------------------------------------------------------------

	/**
	 * @param {string} name
	 * @param {Function} fn
	 * @returns {() => void} unsubscribe
	 */
	on( name, fn ) {
		let list = this.#handlers.get( name );
		if( !list ) this.#handlers.set( name, list = new Set() );
		list.add( fn );
		return () => list.delete( fn );
	}

	emit( name, ...args ) {
		const list = this.#handlers.get( name );
		if( !list ) return;
		for( const fn of [ ...list ] ) {
			try { fn( ...args ); }
			catch( err ) { console.error( `caller state: '${name}' handler failed:`, err ); }
		}
	}

	// -- derived -------------------------------------------------------------

	get game() { return this.gameIndex >= 0 ? this.games[ this.gameIndex ] || null : null; }

	/** what the status bar says about the game that is up */
	get gameStatus() {
		const game = this.game;
		if( !game ) return "";
		if( this.inPlay ) return "In play";
		if( game.status === 5 ) return "Closed";
		if( game.status === 2 ) return "Ready";
		return "Status " + game.status;
	}

	/** @param {string} command  one of COMMANDS */
	can( command ) {
		const game = this.game;
		switch( command ) {
		case "startGame":    return !!this.session && !!game && !this.inPlay && game.status !== 5;
		case "resumeGame":   return !!this.session && !!game && !this.inPlay && game.status === 5;
		case "endGame":
		case "refundGame":
		case "validate":
		case "resetGame":    return this.inPlay;
		case "closeSession": return !!this.session && !this.inPlay;
		case "wild":         return true;
		default:             return false;
		}
	}

	/**
	 * Use a BallQueue for the wild/dedup logic.  Without one, calls are kept
	 * in a plain list, which is all the screens need.
	 */
	setQueue( queue ) {
		this.queue = queue;
		if( queue && queue.reset ) queue.reset();
	}

	get wildState() { return this.queue ? this.queue.wildState : null; }

	// -- game selection --------------------------------------------------------

	/**
	 * Make a game current WITHOUT starting it: paints its board.
	 * @param {number} index
	 */
	selectGame( index ) {
		if( index < 0 || index >= this.games.length ) return false;
		this.gameIndex = index;
		const game = this.games[ index ];
		this.inPlay = IN_PLAY.has( game.status );
		this.#loadMarks( game );
		this.emit( "game", game, index );
		return true;
	}

	/** the game a fresh session should offer: one in play, else the first ready */
	static preferredGame( games ) {
		let ready = -1;
		for( let i = 0; i < games.length; i++ ) {
			const status = games[ i ].status;
			if( IN_PLAY.has( status ) ) return i;
			if( status === 2 && ready < 0 ) ready = i;
		}
		return ready;
	}

	/** the next ready game after `from`, wrapping; -1 when none */
	static nextReady( games, from ) {
		for( let n = from + 1; n < games.length; n++ ) if( games[ n ].status === 2 ) return n;
		for( let n = 0; n < from; n++ ) if( games[ n ].status === 2 ) return n;
		return -1;
	}

	#loadMarks( game ) {
		this.marks = new Set();
		this.order = [];
		if( this.queue ) this.queue.reset();
		const balls = ( game && ( game.balls && game.balls.length ? game.balls : game.marks ) ) || [];
		for( const ball of balls ) {
			if( !ball ) continue;
			this.marks.add( ball );
			this.order.push( ball );
			if( this.queue ) this.queue.enque( ball, true );
		}
		this.lastBall = this.order.length ? this.order[ this.order.length - 1 ] : 0;
	}

	#clearSession() {
		this.session = null;
		this.games = [];
		this.gameIndex = -1;
		this.inPlay = false;
		this.verifying = null;
		this.winners = [];
		this.#loadMarks( null );
	}

	// -- the proxy's messages ----------------------------------------------------

	/**
	 * Apply one message from the game proxy.
	 * @param {object} msg  parsed; msg.op names it
	 * @returns {boolean} whether the op was known
	 */
	receive( msg ) {
		if( !msg || typeof msg.op !== "string" ) return false;
		switch( msg.op ) {
		case "auth":
			this.emit( "auth" );
			return true;
		case "caller":
			this.isCaller = true;
			return true;
		case "error":
			this.lastError = ( msg.reply && ( msg.reply.reason || msg.reply.content ) ) || "refused";
			this.emit( "error", this.lastError, msg.reply );
			return true;
		case "notice":
			this.lastNotice = msg.notice;
			this.emit( "notice", msg.notice, msg.room );
			return true;

		case "sessions":
			this.sessions = msg.sessions || [];
			this.config = msg.config || null;
			if( this.connection !== "ready" ) { this.connection = "ready"; this.emit( "connection", this.connection ); }
			this.emit( "sessions", this.sessions );
			return true;
		case "addSession":
		case "beginSession":
			if( msg.session && !this.sessions.find( s => s.id === msg.session.id ) ) this.sessions.push( msg.session );
			this.emit( "sessions", this.sessions );
			return true;
		case "updateSession": {
			const at = msg.session ? this.sessions.findIndex( s => s.id === msg.session.id ) : -1;
			if( at >= 0 ) this.sessions[ at ] = msg.session;
			else if( msg.session ) this.sessions.push( msg.session );
			this.emit( "sessions", this.sessions );
			return true;
		}
		case "removeSession":
			if( msg.session ) this.sessions = this.sessions.filter( s => s.id !== msg.session.id );
			this.emit( "sessions", this.sessions );
			return true;

		case "playSession": {
			this.session = msg;
			this.games = msg.games || [];
			this.verifying = null;
			this.winners = [];
			const index = CallerState.preferredGame( this.games );
			this.gameIndex = -1;
			this.emit( "session", msg );
			this.emit( "games", this.games );
			if( index >= 0 ) this.selectGame( index );
			else { this.inPlay = false; this.#loadMarks( null ); this.emit( "game", null, -1 ); }
			return true;
		}
		case "endSession":
			this.#clearSession();
			this.emit( "endSession", msg.by );
			this.emit( "game", null, -1 );
			return true;

		case "playGame": {
			// msg.id is the INDEX into the session's games, not games[].id
			const index = Number( msg.id );
			const game = this.games[ index ];
			if( !game ) return true;
			if( game.status === 2 ) game.status = 3;
			else if( game.status === 5 ) game.status = 7;
			this.gameIndex = index;
			this.inPlay = true;
			this.#loadMarks( game );
			this.emit( "playGame", game, index );
			this.emit( "game", game, index );
			return true;
		}
		case "endGame": {
			const game = this.game;
			if( game ) {
				// ending a game with no balls called does not close it: the
				// proxy says what the game is now, and 5 is only the default
				game.status = ( msg.status === undefined || msg.status === null ) ? 5 : msg.status;
				this.inPlay = IN_PLAY.has( game.status );
			}
			this.verifying = null;
			this.emit( "endGame", game, this.gameIndex );
			if( game && !this.inPlay ) {
				const next = CallerState.nextReady( this.games, this.gameIndex );
				if( next >= 0 ) this.selectGame( next );
				else this.emit( "game", game, this.gameIndex );
			} else this.emit( "game", game, this.gameIndex );
			return true;
		}

		case "call": {
			const ball = Number( msg.ball );
			if( !ball ) return true;
			if( this.queue ) this.queue.enque( ball );
			if( !this.marks.has( ball ) ) { this.marks.add( ball ); this.order.push( ball ); }
			this.lastBall = this.queue && this.queue.lastBall ? this.queue.lastBall : ball;
			const game = this.game;
			if( game ) {
				game.marks = [ ...this.marks ];
				game.balls = [ ...this.order ];
			}
			this.emit( "call", ball, this.lastBall );
			return true;
		}
		case "uncall": {
			const ball = Number( msg.ball );
			if( !ball ) return true;
			if( this.queue ) this.queue.deque( ball );
			this.marks.delete( ball );
			this.order = this.order.filter( b => b !== ball );
			this.lastBall = this.queue && this.queue.lastBall ? this.queue.lastBall
			              : ( this.order.length ? this.order[ this.order.length - 1 ] : 0 );
			const game = this.game;
			if( game ) {
				game.marks = [ ...this.marks ];
				game.balls = [ ...this.order ];
			}
			this.emit( "uncall", ball, this.lastBall );
			return true;
		}
		case "precall":
			this.emit( "precall", msg.balls, msg.sessionId, msg.gameId );
			return true;

		case "setPattern": {
			// msg.game is usually the games INDEX; the proxy has sent an id too
			let index = Number( msg.game );
			if( !this.games[ index ] ) index = this.games.findIndex( g => g.id === msg.game );
			const game = this.games[ index ];
			if( game ) game.pattern = msg.pattern;
			this.emit( "pattern", game, index, msg.pattern );
			if( index === this.gameIndex ) this.emit( "game", game, index );
			return true;
		}

		case "verify":
			this.verifying = msg.enable ? ( msg.winners || true ) : null;
			this.winners = ( msg.enable && msg.winners && msg.winners.WinningDetails ) || [];
			this.emit( "verify", this.verifying, this.winners );
			return true;
		case "winner":
			if( msg.winner ) this.winners.push( msg.winner );
			this.emit( "winner", msg.winner );
			return true;
		case "win":
		case "no-win":
		case "cardError":
			this.emit( msg.op, msg.result );
			return true;
		case "badCard":
			this.emit( "badCard", msg.card );
			return true;

		case "whoami":
			this.me = msg.me;
			this.room = msg.room || null;
			this.emit( "whoami", this.me, this.room );
			return true;
		case "presence":
			this.callers = msg.callers || [];
			this.emit( "presence", this.callers );
			return true;
		case "monitor_ball":
			this.emit( "monitorBall", msg.back, msg.front );
			return true;
		default:
			return false;
		}
	}

	/** the socket changed state; "offline" forgets everything the proxy told us */
	setConnection( status ) {
		if( status === this.connection ) return;
		this.connection = status;
		if( status === "offline" ) {
			this.sessions = [];
			this.callers = [];
			this.#clearSession();
			this.emit( "sessions", this.sessions );
			this.emit( "presence", this.callers );
			this.emit( "game", null, -1 );
		}
		this.emit( "connection", status );
	}
}

/** A caller is named by whoever is logged in at it, else by where it is. */
export function callerName( caller ) {
	return ( caller && ( caller.who || caller.at ) ) || "unknown";
}
