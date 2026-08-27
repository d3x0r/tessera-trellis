/**
 * @fileoverview Web Page plugin — an embedded iframe.
 *
 * Client half only: there is no server behaviour to register, which is what a
 * one-sided plugin looks like. Drop the directory in, enable it in the Plugins
 * panel, restart, and `web/Web Page` appears under `web` in the create menu
 * with no menu code changed anywhere.
 *
 * This control is also the case the edit overlay exists for. An iframe captures
 * every pointer event inside its own document, so a designer that listened on
 * each control's DOM node could never drag one — you would grab the framed page
 * instead. Because the overlay owns input while editing (and the renderer sets
 * `pointer-events: none` on controls under `.tt-editing`), this drags exactly
 * like a button with no special handling.
 */

import { registerControl } from "../../core/registry.js";
import { PropType } from "../../core/properties.js";
import { expand, watch } from "../../core/variables.js";
import { normalizeUrl, isCustomProtocol, isSameOrigin } from "./url.js";

/*
 * A plugin carries its own styling, so removing the plugin does not leave
 * orphan rules in the editor's stylesheet.  Appended (not prepended) so it
 * wins ties against the base sheet -- popups2's addStyleSheetSrc has the
 * opposite behaviour when handed document.head, which is a known trap.
 */
if( !document.getElementById( "tt-web-styles" ) ) {
	const link = document.createElement( "link" );
	link.id = "tt-web-styles";
	link.rel = "stylesheet";
	link.href = new URL( "./styles.css", import.meta.url ).href;
	document.head.appendChild( link );
}

/*
 * Sandbox presets.
 *
 * The attribute is SUBTRACTIVE: present means "deny everything except what is
 * listed", absent means no restriction at all.  Default to the tightest thing
 * that renders a normal page and let the designer widen it deliberately.
 *
 * "trusted" omits the attribute entirely rather than listing every token,
 * because `allow-scripts` together with `allow-same-origin` lets a same-origin
 * document reach out and remove its own sandbox -- a preset that looked
 * restrictive while being nothing of the sort would be worse than an honest
 * "no sandbox".
 *
 * "app" exists because a page that behaves like an application wants to open
 * links and hand off to mailto:/tel:/custom schemes.  Chrome blocks that with
 * "Navigation to external protocol blocked by sandbox" unless one of
 * allow-popups / allow-top-navigation* is granted.  It uses
 * allow-top-navigation-BY-USER-ACTIVATION rather than blanket
 * allow-top-navigation: the framed page can then follow a link the user
 * clicked, but cannot navigate the whole shell away on its own -- which in a
 * kiosk is an escape from the application entirely.
 */
const SANDBOXES = {
	"strict":        "",
	"scripts":       "allow-scripts",
	"scripts+forms": "allow-scripts allow-forms allow-popups",
	"app":           "allow-scripts allow-forms allow-popups allow-modals"
	                 + " allow-downloads allow-top-navigation-by-user-activation",
	"trusted":       null,
};

const SANDBOX_NAMES = Object.keys( SANDBOXES );

/**
 * Combine a preset with any extra tokens.
 *
 * Returning null means "omit the attribute" -- and extra tokens cannot
 * resurrect it, because adding tokens to "no sandbox" is meaningless and
 * silently ignoring them would be worse than either.
 *
 * @returns {?string} the sandbox attribute value, or null to omit it
 */
function sandboxValue( preset, extra, sameOrigin ) {
	const base = SANDBOXES[ preset ];
	if( base === null ) return null;                  // "trusted"
	const tokens = ( ( base === undefined ? "" : base )
		+ " " + ( extra || "" )
		+ ( sameOrigin ? " allow-same-origin" : "" ) )
		.split( /\s+/ ).filter( Boolean );
	return [ ...new Set( tokens ) ].join( " " );
}

/**
 * Does this combination amount to no sandbox at all?
 *
 * `allow-scripts` plus `allow-same-origin` on a document SAME-ORIGIN with the
 * embedder lets that document reach parent.document, remove its own sandbox
 * attribute and reload itself unsandboxed.  Cross-origin -- a different port
 * counts -- there is no such path, and the grant is exactly what it looks
 * like.  Worth saying out loud at design time either way.
 */
function sandboxIsMoot( value, url ) {
	if( value === null ) return false;                // "trusted" is honest
	return /allow-scripts/.test( value )
		&& /allow-same-origin/.test( value )
		&& isSameOrigin( url );
}

registerControl( "web/Web Page", {
	description: "Embeds a web page. URL accepts %variables.",

	properties: {
		url: { type: PropType.String, label: "URL", default: "",
		       hint: "%VariableName substitutes" },
		sandbox: { type: PropType.Choice, label: "Sandbox",
		           default: "scripts", choices: SANDBOX_NAMES },
		sameOrigin: { type: PropType.Bool, label: "Allow storage", default: false,
		              hint: "keeps the page's real origin: localStorage, cookies" },
		sandboxExtra: { type: PropType.String, label: "Sandbox extra", default: "",
		                hint: "extra allow-* tokens, space separated" },
		allow: { type: PropType.String, label: "Permissions", default: "",
		         hint: "iframe allow=, e.g. fullscreen; clipboard-read" },
		scrolling: { type: PropType.Bool, label: "Scrollable", default: true },
		interactive: { type: PropType.Bool, label: "Interactive", default: true,
		               hint: "off = display only, clicks pass through" },
		refreshSeconds: { type: PropType.Number, label: "Refresh (s)", default: 0,
		                  hint: "0 = never" },
		background: { type: PropType.Color, label: "Backdrop", default: "#14141a" },
		relayActivity: { type: PropType.Bool, label: "Report activity", default: true,
		                 hint: "frame posts tt-activity; keeps the shell awake" },
		allowScreensaverRequest: { type: PropType.Bool, label: "May request screensaver",
		                 default: false,
		                 hint: "frame may ask the shell to blank on demand" },
		security: { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const el = document.createElement( "div" );
		el.className = "tt-web";

		const frame = document.createElement( "iframe" );
		frame.className = "tt-web-frame";
		frame.setAttribute( "referrerpolicy", "no-referrer" );
		frame.setAttribute( "loading", "lazy" );
		frame.title = "Web Page";

		/*
		 * Shown while editing, and whenever there is no URL. A live page is a
		 * poor thing to arrange a layout against — it may animate, play audio,
		 * or render nothing at all if the site refuses to be framed — and the
		 * URL is the useful thing to see at design time anyway.
		 */
		const scrim = document.createElement( "div" );
		scrim.className = "tt-web-scrim";

		el.append( frame, scrim );

		/*
		 * A cross-origin frame leaks nothing -- no input event crosses the
		 * boundary -- so the shell cannot tell whether anyone is using the
		 * framed application. The client has to say so itself, by posting
		 * { type: "tt-activity" } to its parent. This re-dispatches that as a
		 * DOM event which bubbles to the shell's idle watcher.
		 *
		 * The source check is the security boundary and it is deliberately
		 * `event.source === frame.contentWindow`, not an origin string
		 * comparison: it identifies THIS frame rather than anything that
		 * happens to share its origin, so an unrelated window (or another
		 * frame on the same host) cannot keep a station awake or blank it.
		 */
		const onMessage = ( e ) => {
			const state = el._tt;
			if( !state || e.source !== state.frame.contentWindow ) return;
			const type = e.data && e.data.type;
			if( type === "tt-activity" ) {
				if( state.relayActivity )
					el.dispatchEvent( new CustomEvent( "tt-activity", { bubbles: true } ) );
			} else if( type === "tt-screensaver" ) {
				// Opt-in: a page asking the shell to blank is an instruction,
				// not a report, so it stays off unless the designer allows it.
				if( state.allowScreensaverRequest )
					el.dispatchEvent( new CustomEvent( "tt-screensaver", { bubbles: true } ) );
			}
		};
		window.addEventListener( "message", onMessage );

		// Per-instance state; dispose() must be able to find all of it.
		el._tt = { frame, scrim, timer: null, unwatch: null, src: null, editing: false,
		           onMessage, relayActivity: true, allowScreensaverRequest: false };
		return el;
	},

	update( el, inst ) {
		const s = el._tt;
		const p = inst.props;

		el.style.background = p.background;
		s.relayActivity = p.relayActivity !== false;
		s.allowScreensaverRequest = !!p.allowScreensaverRequest;
		s.frame.setAttribute( "scrolling", p.scrolling ? "auto" : "no" );
		s.frame.style.pointerEvents = p.interactive ? "" : "none";

		const sandbox = sandboxValue( p.sandbox, p.sandboxExtra, p.sameOrigin );
		if( sandbox === null ) s.frame.removeAttribute( "sandbox" );
		else s.frame.setAttribute( "sandbox", sandbox );

		if( p.allow ) s.frame.setAttribute( "allow", p.allow );
		else s.frame.removeAttribute( "allow" );

		if( s.unwatch ) s.unwatch();
		const apply = () => setSrc( el, normalizeUrl( expand( p.url ) ) );
		apply();
		s.unwatch = watch( p.url, apply );

		startRefresh( el, inst );
		paintScrim( el, inst );
	},

	onShow( el, inst )  { startRefresh( el, inst ); },
	onHide( el )        { stopRefresh( el ); },

	/*
	 * Stop reloading and cover the frame while the layout is being arranged --
	 * the direct equivalent of the C Clock's OnEditBegin calling StopClock().
	 */
	onEditBegin( el, inst ) {
		el._tt.editing = true;
		stopRefresh( el );
		paintScrim( el, inst );
	},

	onEditEnd( el, inst ) {
		el._tt.editing = false;
		paintScrim( el, inst );
		startRefresh( el, inst );
	},

	dispose( el ) {
		stopRefresh( el );
		window.removeEventListener( "message", el._tt.onMessage );
		if( el._tt.unwatch ) el._tt.unwatch();
		// Drop the document so a removed control cannot keep playing audio.
		el._tt.frame.src = "about:blank";
	},
} );

/**
 * Assign src only when it actually changed.
 *
 * Setting .src reloads the frame even to an identical value, so an
 * unconditional assignment would reload the page on every unrelated property
 * edit -- move the control, and the dashboard inside it flickers and refetches.
 */
function setSrc( el, url ) {
	const s = el._tt;
	if( url === s.src ) return;
	s.src = url;
	s.frame.src = url || "about:blank";
}

/** Force a reload; reassigning the same src is a reload, so bypass setSrc. */
function reload( el ) {
	const s = el._tt;
	if( s.src ) s.frame.src = s.src;
}

function startRefresh( el, inst ) {
	stopRefresh( el );
	const s = el._tt;
	const seconds = Number( inst.props.refreshSeconds ) || 0;
	// Never while editing: a page that reloads under the cursor is unarrangeable.
	if( seconds <= 0 || s.editing || !s.src ) return;
	s.timer = setInterval( () => reload( el ), Math.max( 1, seconds ) * 1000 );
}

function stopRefresh( el ) {
	if( el._tt.timer ) { clearInterval( el._tt.timer ); el._tt.timer = null; }
}

/** The design-time face: what this control is, and where it points. */
function paintScrim( el, inst ) {
	const s = el._tt;
	const url = s.src;
	const show = s.editing || !url;
	s.scrim.hidden = !show;
	if( !show ) return;

	s.scrim.textContent = "";
	const title = document.createElement( "div" );
	title.className = "tt-web-scrim-title";
	title.textContent = url ? "Web Page" : "Web Page — no URL set";

	const where = document.createElement( "div" );
	where.className = "tt-web-scrim-url";
	where.textContent = url || "";

	s.scrim.append( title, where );

	if( url ) {
		const note = document.createElement( "div" );
		note.className = "tt-web-scrim-note";
		const seconds = Number( inst.props.refreshSeconds ) || 0;
		const value = sandboxValue( inst.props.sandbox, inst.props.sandboxExtra,
			inst.props.sameOrigin );
		const bits = [ value === null ? "no sandbox" : inst.props.sandbox ];
		if( inst.props.sameOrigin ) bits.push( "storage" );
		if( seconds > 0 ) bits.push( `refresh ${seconds}s` );
		if( !inst.props.interactive ) bits.push( "display only" );
		note.textContent = bits.join( " · " );
		s.scrim.appendChild( note );

		/*
		 * A sandboxed frame refuses to navigate to a custom scheme, and says so
		 * only in the console.  Saying it here means the designer finds out
		 * while placing the control rather than when a user clicks something.
		 */
		if( isCustomProtocol( url ) ) {
			const warn = document.createElement( "div" );
			warn.className = "tt-web-scrim-warn";
			warn.textContent = "custom protocol — a sandboxed frame will refuse this;"
				+ " grant allow-popups or a top-navigation token";
			s.scrim.appendChild( warn );
		}

		/*
		 * Say when the sandbox is not actually restraining anything, rather
		 * than letting it read as protection that is not there.
		 */
		if( sandboxIsMoot( value, url ) ) {
			const warn = document.createElement( "div" );
			warn.className = "tt-web-scrim-warn";
			warn.textContent = "storage + scripts on a same-origin page is the same as"
				+ " no sandbox — the page can remove its own";
			s.scrim.appendChild( warn );
		}
	}
}
