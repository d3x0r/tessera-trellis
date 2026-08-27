/**
 * @fileoverview Session control -- what 'Quit' becomes on the web.
 *
 * The original Quit POS ended a trusted operator session by terminating the
 * shell.  There is no honest equivalent over HTTP, so the mode is explicit and
 * the deployment picks which one is meaningful.  The control only announces
 * the intent; the application decides what to do with it.
 */

import { registerControl } from "../core/registry.js";
import { commonButtonProperties } from "../core/properties.js";
import { PropType } from "../core/properties.js";
import { buildButtonFace, updateButtonFace, disposeButtonFace } from "./button.js";

/** @enum {string} */
export const SessionMode = {
	/** Drop the session and return to login -- the closest analogue. */
	Logout: "logout",
	/** Return to the canvas's startup page. */
	Home:   "home",
	/** Re-fetch the document. */
	Reload: "reload",
	/** window.close(); only honest in a popped-out window or kiosk shell. */
	Close:  "close",
};

const { nextPage, ...buttonProps } = commonButtonProperties;

registerControl( "security/Session", {
	description: "Ends or resets the session (the old Quit button).",
	properties: {
		...buttonProps,
		mode: { type: PropType.Choice, label: "Action",
		        default: SessionMode.Logout,
		        choices: Object.values( SessionMode ) },
		confirm: { type: PropType.Bool, label: "Confirm first", default: true },
	},

	create( inst ) {
		const el = document.createElement( "button" );
		el.className = "tt-button tt-session";
		el._ttFace = buildButtonFace( el );
		el.addEventListener( "click", () => {
			if( inst.props.confirm && !window.confirm( `${inst.props.mode}?` ) ) return;
			el.dispatchEvent( new CustomEvent( "tt-session",
				{ bubbles: true, detail: { mode: inst.props.mode, control: inst } } ) );
		} );
		return el;
	},

	update( el, inst ) {
		updateButtonFace( el._ttFace,
			Object.assign( {}, inst.props, { text: inst.props.text || "Quit" } ),
			null, inst.page && inst.page.canvas );
	},

	dispose( el ) {
		disposeButtonFace( el._ttFace );
	},
} );
