/**
 * @fileoverview Idle watching, for screen-saver pages.
 *
 * Timeouts here are long -- hours, in a station that nobody touches between
 * shifts -- which drives two decisions:
 *
 * 1. It POLLS a timestamp rather than arming one long setTimeout. A timer set
 *    for four hours does not survive the machine sleeping or the tab being
 *    throttled in any predictable way; comparing `Date.now()` against the last
 *    activity does, and costs one comparison every 30s.
 * 2. It exposes trigger() so the screen-saver can also be demanded outright --
 *    a button, or the framed client asking for it -- without pretending the
 *    idle timer fired.
 *
 * Activity arrives from two places: input on the shell's own page, and
 * `tt-activity` events, which is how a cross-origin framed client reports
 * input the shell cannot see for itself (see plugins/iframe).
 */

/** Input on our own page that counts as the user being present. */
const LOCAL_EVENTS = [ "pointerdown", "pointermove", "keydown", "wheel", "touchstart" ];

/** How often to compare the clock. Cheap, and far below any sane timeout. */
const POLL_MS = 30_000;

/**
 * @param {object}   opts
 * @param {number}   opts.minutes    idle timeout; 0 or less disables watching
 * @param {Function} opts.onIdle     called once when the timeout is crossed
 * @param {Function} opts.onWake     called once when activity resumes
 * @param {EventTarget} [opts.target] where to listen; defaults to window
 * @param {number}   [opts.pollMs]  how often to compare the clock. Only worth
 *                                  setting for a short timeout, or a test that
 *                                  drives the clock itself.
 * @returns {{stop:Function, trigger:Function, wake:Function, get idle():boolean,
 *           get sinceActivity():number}}
 */
export function watchIdle( opts ) {
	const minutes = Number( opts.minutes ) || 0;
	const target = opts.target || window;

	let last = Date.now();
	let idle = false;
	let timer = null;

	const goIdle = ( reason ) => {
		if( idle ) return;
		idle = true;
		opts.onIdle && opts.onIdle( reason );
	};

	const wake = () => {
		last = Date.now();
		if( !idle ) return;
		idle = false;
		opts.onWake && opts.onWake();
	};

	/*
	 * Activity while idle wakes; activity while active only bumps the clock.
	 * Both paths run on every input, so this stays allocation-free.
	 */
	const onActivity = () => { if( idle ) wake(); else last = Date.now(); };

	for( const name of LOCAL_EVENTS )
		target.addEventListener( name, onActivity, { passive: true, capture: true } );
	// Relayed from a framed client that the shell cannot observe directly.
	document.addEventListener( "tt-activity", onActivity );
	// An explicit request: show the screen saver now.
	document.addEventListener( "tt-screensaver", () => goIdle( "requested" ) );

	if( minutes > 0 ) {
		const limit = minutes * 60_000;
		timer = setInterval( () => {
			if( !idle && Date.now() - last >= limit ) goIdle( "timeout" );
		}, Math.max( 1, Number( opts.pollMs ) || POLL_MS ) );
	}

	return {
		get idle() { return idle; },
		get sinceActivity() { return Date.now() - last; },
		/** Force the idle state now, regardless of the timer. */
		trigger() { goIdle( "requested" ); },
		wake,
		stop() {
			if( timer ) clearInterval( timer );
			for( const name of LOCAL_EVENTS )
				target.removeEventListener( name, onActivity, { capture: true } );
		},
	};
}
