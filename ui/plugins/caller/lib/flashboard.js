/**
 * @fileoverview The 75-ball flashboard, as a component.
 *
 * Five rows of fifteen tiles with an optional B-I-N-G-O letter at the head of
 * each row.  A click on an unmarked tile asks to call that ball, on a marked
 * one to uncall it; the board itself never marks on a click -- the proxy's
 * answer does, so every board in the room agrees.
 *
 * Fills whatever box it is given (CSS grid, no fixed sizes), which is what
 * lets it be a trellis control instead of a 60vw-by-25vh corner of a page.
 */

const LETTER_CLASS = [ "blue", "red", "white", "green", "yellow" ];

export class Flashboard {
	el = document.createElement( "div" );
	tiles = [];
	/** true while input to this board is refused (a read-only view) */
	locked = false;
	onCall = null;
	onUncall = null;

	/**
	 * @param {{showLetters?:boolean, locked?:boolean, balls?:number}} [opts]
	 */
	constructor( opts = {} ) {
		this.el.className = "ttc-flashboard";
		this.locked = !!opts.locked;
		const showLetters = opts.showLetters !== false;
		this.el.classList.toggle( "no-letters", !showLetters );

		for( let r = 0; r < 5; r++ ) {
			const row = document.createElement( "div" );
			row.className = "ttc-fb-row";
			if( showLetters ) {
				const letter = document.createElement( "div" );
				letter.className = "ttc-fb-letter " + LETTER_CLASS[ r ];
				letter.textContent = "BINGO"[ r ];
				row.appendChild( letter );
			}
			for( let c = 0; c < 15; c++ ) {
				const n = r * 15 + c + 1;
				const tile = document.createElement( "div" );
				tile.className = "ttc-fb-tile unmarked";
				tile.dataset.ball = String( n );
				const text = document.createElement( "span" );
				text.className = "ttc-fb-text";
				text.textContent = String( n );
				tile.appendChild( text );
				tile.addEventListener( "click", () => {
					if( this.locked ) return;
					if( tile.classList.contains( "marked" ) ) { if( this.onUncall ) this.onUncall( n ); }
					else if( this.onCall ) this.onCall( n );
				} );
				row.appendChild( tile );
				this.tiles.push( tile );
			}
			this.el.appendChild( row );
		}
	}

	#tile( n ) { return this.tiles[ n - 1 ] || null; }

	mark( n ) {
		const tile = this.#tile( n );
		if( !tile ) return;
		tile.classList.add( "marked" );
		tile.classList.remove( "unmarked", "last" );
	}

	unmark( n ) {
		const tile = this.#tile( n );
		if( !tile ) return;
		tile.classList.add( "unmarked" );
		tile.classList.remove( "marked", "last" );
	}

	/** highlight the most recent call; 0 clears it */
	setLast( n ) {
		for( const tile of this.tiles ) tile.classList.remove( "last" );
		const tile = n && this.#tile( n );
		if( tile ) tile.classList.add( "last" );
	}

	reset() {
		for( let n = 1; n <= 75; n++ ) this.unmark( n );
	}

	/** paint a whole set at once */
	setMarks( balls, last ) {
		this.reset();
		for( const ball of balls || [] ) if( ball ) this.mark( ball );
		this.setLast( last || 0 );
	}

	/**
	 * Where ball n's tile is on screen, so a ball overlay can fly from it.
	 * @returns {{x:number,y:number,w:number,h:number}|null} client pixels
	 */
	ballPosition( n ) {
		const tile = this.#tile( n );
		if( !tile || !tile.offsetParent ) return null;
		const r = tile.getBoundingClientRect();
		if( !r.width || !r.height ) return null;
		return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
	}
}
