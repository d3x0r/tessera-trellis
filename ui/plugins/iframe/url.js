/**
 * @fileoverview URL normalisation for the Web Page control.
 *
 * Pure and dependency-free so it can be tested outside a browser.
 */

/** Schemes an iframe can actually load, and which need no rewriting. */
const LOADABLE = /^(?:https?|about|blob|data):/i;

/** Anything shaped like scheme: -- letters, digits, '+', '-', '.' are all legal. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** "localhost:8099", "example.com:8080/x" -- a host and port, not a scheme. */
const HOST_PORT = /^([a-z][a-z0-9+.-]*):(\d+)(\/.*)?$/i;

/** /path, ./path, ../path */
const RELATIVE = /^\.{0,2}\//;

/**
 * Resolve what someone typed into something an iframe can load.
 *
 * The case that bites: **"localhost:8099" is not parsed as host:port.** Scheme
 * grammar allows letters, digits, '+', '-' and '.', so a browser reads
 * `localhost:` as the SCHEME and `8099` as the path. That is a custom
 * protocol, and a sandboxed frame refuses it with "Navigation to external
 * protocol blocked by sandbox" -- an error that points at the sandbox while
 * the actual fault is the missing `http://`. Widening the sandbox would hide
 * it rather than fix it.
 *
 * A missing scheme inherits `location.protocol` rather than defaulting to
 * https:. That is not only tidiness: an https page cannot frame an http one at
 * all (mixed content), so inheriting the page's own protocol is the only
 * default that cannot produce a frame guaranteed to fail.
 *
 * A path relative to the site must be written `./page.html` or `/page.html`.
 * A bare `page.html` is treated as a host, because for this control a bare
 * string is overwhelmingly a website -- and guessing between the two by
 * sniffing for file extensions would be wrong less obviously.
 *
 * @param {string} raw
 * @param {string} [proto]  defaults to location.protocol
 * @returns {string}
 */
export function normalizeUrl( raw, proto ) {
	const url = String( raw == null ? "" : raw ).trim();
	if( !url ) return "";

	const scheme = proto
		|| ( typeof location !== "undefined" && location.protocol ) || "https:";

	if( LOADABLE.test( url ) ) return url;
	if( url.startsWith( "//" ) ) return scheme + url;
	if( RELATIVE.test( url ) ) return url;

	const hostPort = HOST_PORT.exec( url );
	if( hostPort )
		return `${scheme}//${hostPort[ 1 ]}:${hostPort[ 2 ]}${hostPort[ 3 ] || ""}`;

	// A real custom scheme (mailto:, tel:, an app handler) is left alone --
	// the scrim flags it, because a sandboxed frame will refuse to follow it.
	if( HAS_SCHEME.test( url ) ) return url;

	return scheme + "//" + url;
}

/**
 * Does this URL name a scheme a sandboxed frame will refuse to navigate to?
 * Used only to warn at design time.
 */
export function isCustomProtocol( url ) {
	return !!url && HAS_SCHEME.test( url ) && !LOADABLE.test( url );
}

/**
 * Is `url` the same origin as the page doing the framing?
 *
 * Origin includes the PORT, so a designer on :8099 framing an app on :8085 is
 * cross-origin -- which is what decides whether `allow-same-origin` is a
 * reasonable grant or a way of disabling the sandbox while appearing not to.
 *
 * @param {string} url    already normalised
 * @param {string} [base] defaults to location.href
 */
export function isSameOrigin( url, base ) {
	try {
		const here = base
			|| ( typeof location !== "undefined" && location.href ) || "https://example.invalid/";
		return new URL( url, here ).origin === new URL( here ).origin;
	} catch( err ) {
		return false;
	}
}
