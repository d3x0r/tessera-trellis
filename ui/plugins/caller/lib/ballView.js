/**
 * @fileoverview The rolling-ball view: the last ball called, large, and the
 * balls before it racked in the order they came.
 *
 * A port of the caller page's ballList.js onto the trellis: the drawing is
 * /common/bingo/ballView/ballView.mjs (three.js), imported from the game
 * proxy and handed in here, so this file is only the choreography -- where a
 * ball flies from and to, and how fast.
 *
 * ballView.mjs draws through an OrthographicCamera( 0,1920, 0,1080 ) and
 * scaleTo( n, z ) sets a ball to 1920/43 * z units, so screen pixels have to
 * be converted into that space before they mean anything to it.
 */

const lastBallPos = { x: 600, y: 520, scale: 2.5 };
const moveToPosIn = 500;
const sizeToPosIn = 250;
const ballPosOrigin = { x: 140, y: 120 };
const ballPosSize = { x: 86 * 0.8, y: 86 * 0.8, scale: 0.8 };
const flyToLastIn = 400;
const flyToBoardIn = 400;
const worldSize = { x: 1920, y: 1080 };
const ballUnit = 1920 / 43;
/** the ball drawn at a board spot is a fraction of the tile box the spot occupies */
const boardBallScale = 0.3;

class Ball {
	moveStartAt = Date.now();
	moveDel = 0;
	sizeStartAt = Date.now();
	sizeDel = 0;
	x = 960; y = 540;
	xTo = 0; yTo = 0;
	s = 0; sTo = 0;
	onDone = null;
	number = 0;

	constructor( n, iface ) { this.number = n; this.iface = iface; }

	moveToIn( x, y, t ) {
		this.moveStartAt = Date.now();
		this.moveDel = t || 1;
		this.xTo = x; this.yTo = y;
		this.onDone = null;   // a new move cancels a pending completion
	}
	sizeToIn( s, t ) {
		this.sizeStartAt = Date.now();
		this.sizeDel = t || 1;
		this.sTo = s;
	}
	placeAt( x, y, s ) {
		this.moveDel = 0; this.sizeDel = 0; this.onDone = null;
		this.x = this.xTo = x; this.y = this.yTo = y;
		this.iface.moveTo( this.number, x, y );
		if( s !== undefined ) {
			this.s = this.sTo = s;
			this.iface.scaleTo( this.number, s );
		}
	}
	animate() {
		const now = Date.now();
		if( this.sizeDel ) {
			const del = ( now - this.sizeStartAt ) / this.sizeDel;
			if( del > 1 ) {
				this.s = this.sTo;
				this.sizeDel = 0;
				this.iface.scaleTo( this.number, this.s );
			} else
				this.iface.scaleTo( this.number, this.sTo * del + this.s * ( 1 - del ) );
		}
		if( this.moveDel ) {
			const del = ( now - this.moveStartAt ) / this.moveDel;
			if( del > 1 ) {
				this.x = this.xTo; this.y = this.yTo;
				this.moveDel = 0;
				this.iface.moveTo( this.number, this.x, this.y );
				if( this.onDone ) { const done = this.onDone; this.onDone = null; done(); }
			} else
				this.iface.moveTo( this.number, this.xTo * del + this.x * ( 1 - del )
				                              , this.yTo * del + this.y * ( 1 - del ) );
		}
	}
}

export class BallView {
	canvas = document.createElement( "canvas" );
	balls = [];
	ballOrder = [];
	retiring = [];   // flying back to the board, hidden when they land
	lastBall = null;

	/**
	 * @param {{setupWorldView:Function, getBallInterface:Function}} ballViewModule
	 *        /common/bingo/ballView/ballView.mjs, already imported
	 */
	constructor( ballViewModule ) {
		this.canvas.className = "ttc-ball-canvas";
		this.canvas.width = 1280;
		this.canvas.height = 540;
		this.iface = ballViewModule.getBallInterface();
		const viewer = ballViewModule.setupWorldView( this.canvas );
		viewer.onAnimate = this.animate.bind( this );
		for( let n = 0; n < 75; n++ ) {
			this.balls.push( new Ball( n, this.iface ) );
			this.iface.hide( n );
		}
	}

	/** client pixels -> the ball view's 1920x1080 world */
	toWorld( pos ) {
		const r = this.canvas.getBoundingClientRect();
		if( !r.width || !r.height ) return null;
		return { x: ( pos.x - r.left ) / r.width * worldSize.x
		       , y: ( pos.y - r.top ) / r.height * worldSize.y
		       , scale: ( pos.w ? ( pos.w / r.width * worldSize.x ) : ballUnit ) / ballUnit * boardBallScale };
	}

	animate() {
		for( const entry of this.ballOrder ) entry.ball.animate();
		for( const ball of this.retiring ) ball.animate();
		if( this.lastBall ) this.lastBall.animate();
	}

	/** fly a ball back to its spot on the board at the spot's size, then hide it */
	retire( ball, to ) {
		const target = to && this.toWorld( to );
		if( !target ) { this.iface.hide( ball.number ); return; }
		ball.moveToIn( target.x, target.y, flyToBoardIn );
		ball.sizeToIn( target.scale, flyToBoardIn );
		ball.onDone = () => {
			const i = this.retiring.indexOf( ball );
			if( i >= 0 ) this.retiring.splice( i, 1 );
			this.iface.hide( ball.number );
		};
		if( this.retiring.indexOf( ball ) < 0 ) this.retiring.push( ball );
	}

	/** called again before it landed: keep it, do not hide it */
	unretire( ball ) {
		const i = this.retiring.indexOf( ball );
		if( i >= 0 ) this.retiring.splice( i, 1 );
		ball.onDone = null;
	}

	clear() {
		this.ballOrder.length = 0;
		this.retiring.length = 0;
		this.lastBall = null;
		for( let b = 0; b < 75; b++ ) this.iface.hide( b );
	}

	#rack( entry, instant ) {
		const x = ballPosOrigin.x + ( entry.pos % 15 ) * ballPosSize.x;
		const y = ballPosOrigin.y + Math.floor( entry.pos / 15 ) * ballPosSize.y;
		if( instant ) entry.ball.placeAt( x, y, ballPosSize.scale );
		else {
			entry.ball.moveToIn( x, y, moveToPosIn );
			entry.ball.sizeToIn( ballPosSize.scale, sizeToPosIn );
		}
	}

	/**
	 * Make ball n the last ball.  `from` is an optional screen position (see
	 * Flashboard.ballPosition) it flies in from; `instant` places with no tween
	 * at all, for restoring a game's called balls.
	 */
	setLastBall( n, from, instant ) {
		if( !n ) {
			if( !this.ballOrder.length ) this.lastBall = null;
			return;
		}
		if( this.lastBall ) {
			if( this.lastBall.number === n - 1 ) return;
			// already racked: bring it forward and close the gap
			for( let b = 0; b < this.ballOrder.length; b++ ) {
				if( this.ballOrder[ b ].ball.number === n - 1 ) {
					const entry = this.ballOrder.splice( b, 1 )[ 0 ];
					this.ballOrder.push( entry );
					for( ; b < this.ballOrder.length; b++ ) {
						this.ballOrder[ b ].pos = b;
						this.#rack( this.ballOrder[ b ], false );
					}
					return;
				}
			}
			const entry = { pos: this.ballOrder.length, ball: this.lastBall };
			this.ballOrder.push( entry );
			this.#rack( entry, instant );
		}

		const ball = this.balls[ n - 1 ];
		this.unretire( ball );
		this.lastBall = ball;
		this.iface.show( n - 1, n );   // show is also stop-at
		const start = from && this.toWorld( from );
		if( instant ) {
			ball.placeAt( lastBallPos.x, lastBallPos.y, lastBallPos.scale );
		} else if( start ) {
			// come off its spot on the board rather than from wherever it was left
			ball.x = start.x; ball.y = start.y; ball.s = start.scale;
			this.iface.moveTo( n - 1, ball.x, ball.y );
			this.iface.scaleTo( n - 1, ball.s );
			ball.moveToIn( lastBallPos.x, lastBallPos.y, flyToLastIn );
			ball.sizeToIn( lastBallPos.scale, flyToLastIn );
		} else {
			ball.moveToIn( lastBallPos.x, lastBallPos.y, 0 );
			ball.sizeToIn( lastBallPos.scale, 0 );
		}
	}

	/** take ball n away; `to` is the board spot it flies back to (optional) */
	uncall( n, to ) {
		if( !n ) return;
		n--;
		if( this.lastBall && this.lastBall.number === n ) {
			const leaving = this.lastBall;
			if( this.ballOrder.length ) {
				const entry = this.ballOrder.pop();
				this.lastBall = entry.ball;
				entry.ball.moveToIn( lastBallPos.x, lastBallPos.y, 500 );
				entry.ball.sizeToIn( lastBallPos.scale, 250 );
			} else this.lastBall = null;
			this.retire( leaving, to );
			return;
		}
		let b;
		for( b = 0; b < this.ballOrder.length; b++ ) {
			if( this.ballOrder[ b ].ball.number === n ) {
				const entry = this.ballOrder.splice( b, 1 )[ 0 ];
				this.retire( entry.ball, to );
				break;
			}
		}
		for( ; b < this.ballOrder.length; b++ ) {
			this.ballOrder[ b ].pos = b;
			this.#rack( this.ballOrder[ b ], false );
		}
	}

	/** paint a whole game: every ball racked, the last one large, no tween */
	setBalls( order ) {
		this.clear();
		for( const ball of order || [] ) if( ball ) this.setLastBall( ball, null, true );
	}
}
