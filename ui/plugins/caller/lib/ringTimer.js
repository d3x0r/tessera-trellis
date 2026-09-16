/**
 * @fileoverview Countdown ring for the caller.
 *
 * The whole circle is the configured time; the arc drains as it counts down,
 * going from dark red to light red, then lands on green with a one second
 * sweep of alternating greens and a ding.  A ball call starts it.  Clicking it
 * opens a row of durations to pick from.
 *
 * Ported from the caller page's ringTimer.js; the duration chooser is an
 * inline strip here instead of a popup so this depends on nothing.
 */

const DURATIONS = [ 2, 4, 7, 8, 10, 11, 14 ];
const DEFAULT_SECONDS = 11;

const ringRadius = 42;
const ringLength = 2 * Math.PI * ringRadius;
const sweepMs = 1000;
const sweepSegments = 8;

const colorFull = { r: 0x6b, g: 0x0f, b: 0x0f };   // dark red, whole time still left
const colorLow  = { r: 0xff, g: 0x6b, b: 0x6b };   // light red, about to expire

function mix( from, to, del ) {
	const at = c => Math.round( from[ c ] + ( to[ c ] - from[ c ] ) * del );
	return `rgb(${at( 'r' )},${at( 'g' )},${at( 'b' )})`;
}

const svgNS = "http://www.w3.org/2000/svg";
function svg( name, attrs ) {
	const el = document.createElementNS( svgNS, name );
	for( const a in attrs ) el.setAttribute( a, attrs[ a ] );
	return el;
}

export class RingTimer {
	el = document.createElement( "div" );
	target = 0;              // seconds this run is counting, 0 when idle
	seconds = DEFAULT_SECONDS;
	from = Date.now();
	sound = null;
	#pending = 0;

	/** @param {{seconds?:number, sound?:string, durations?:number[]}} [opts] */
	constructor( opts = {} ) {
		this.seconds = Number( opts.seconds ) || DEFAULT_SECONDS;
		if( opts.sound ) this.setSound( opts.sound );
		this.durations = ( opts.durations && opts.durations.length ) ? opts.durations : DURATIONS;

		this.el.className = "ttc-ring-timer";
		const draw = svg( "svg", { viewBox: "0 0 100 100" } );
		this.el.appendChild( draw );

		const track = svg( "circle", { class: "ttc-ring-track", cx: 50, cy: 50, r: ringRadius } );
		this.arc   = svg( "circle", { class: "ttc-ring-arc",   cx: 50, cy: 50, r: ringRadius } );
		this.sweep = svg( "circle", { class: "ttc-ring-sweep", cx: 50, cy: 50, r: ringRadius } );
		this.arc.style.strokeDasharray = ringLength;
		this.sweep.style.strokeDasharray = ( ringLength / sweepSegments ) + " " + ( ringLength / sweepSegments );
		this.sweep.style.display = "none";
		draw.append( track, this.arc, this.sweep );

		this.text = svg( "text", { class: "ttc-ring-text", x: 50, y: 50,
		                           "text-anchor": "middle", "dominant-baseline": "central" } );
		draw.appendChild( this.text );

		// the duration strip, shown over the ring on click
		this.menu = document.createElement( "div" );
		this.menu.className = "ttc-ring-menu";
		this.menu.hidden = true;
		for( const s of this.durations ) {
			const b = document.createElement( "button" );
			b.type = "button";
			b.textContent = String( s );
			b.addEventListener( "click", ( evt ) => {
				evt.stopPropagation();
				this.seconds = s;
				this.menu.hidden = true;
				this.start();
			} );
			this.menu.appendChild( b );
		}
		this.el.appendChild( this.menu );
		this.el.addEventListener( "click", () => { this.menu.hidden = !this.menu.hidden; } );

		this.expire();   // idle: full green ring reading 00, no sound
	}

	setSound( url ) {
		try { this.sound = url ? new Audio( url ) : null; }
		catch( err ) { this.sound = null; }
	}

	#setText( n ) {
		this.text.textContent = String( Math.max( 0, n | 0 ) ).padStart( 2, '0' );
	}

	#stopLoop() {
		if( this.#pending ) { cancelAnimationFrame( this.#pending ); this.#pending = 0; }
	}

	#loop = () => {
		this.#pending = 0;
		const left = this.target - ( Date.now() - this.from ) / 1000;
		if( this.target && left > 0 ) {
			const del = 1 - left / this.target;   // 0 at the start, 1 at expiry
			this.arc.style.strokeDashoffset = ringLength * del;
			this.arc.style.stroke = mix( colorFull, colorLow, del );
			this.#setText( Math.ceil( left ) );
			this.#pending = requestAnimationFrame( this.#loop );
			return;
		}
		this.expire();
	};

	expire() {
		const wasRunning = !!this.target;
		this.target = 0;
		this.#setText( 0 );
		this.arc.style.strokeDashoffset = 0;
		this.arc.style.stroke = "";        // hands the colour back to the stylesheet
		this.el.classList.add( "done" );
		if( wasRunning ) {
			if( this.sound ) { const p = this.sound.play(); if( p ) p.catch( () => {} ); }
			this.#startSweep();
		}
	}

	/** one second of alternating greens chasing around the ring */
	#startSweep() {
		const seg = ringLength / sweepSegments;
		const at = Date.now();
		this.sweep.style.display = "";
		const spin = () => {
			const del = ( Date.now() - at ) / sweepMs;
			if( del >= 1 ) { this.sweep.style.display = "none"; return; }
			this.sweep.style.strokeDashoffset = -seg * 2 * del;
			requestAnimationFrame( spin );
		};
		spin();
	}

	start() {
		this.target = this.seconds;
		this.from = Date.now();
		this.el.classList.remove( "done" );
		this.sweep.style.display = "none";
		this.#stopLoop();
		this.#loop();
	}

	stop() {
		this.#stopLoop();
		this.expire();
	}

	dispose() { this.#stopLoop(); }
}
