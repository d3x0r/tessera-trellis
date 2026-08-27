/**
 * @fileoverview Common button.
 *
 * Layer order matters and is the whole point of the glare-set design:
 *
 *   1. mask     -- the 3-channel image, colourised by one feColorMatrix
 *   2. text
 *   3. lens     -- mostly-transparent specular, drawn OVER the text
 *
 * so the text picks up the highlight and the refraction from the lens instead
 * of sitting flatly on top of the button.
 *
 * The whole of the C version's OnConfigureControl dialog plumbing, its
 * OnSaveControl fprintf block, and the matching AddConfigurationMethod reload
 * callbacks are replaced by the properties declaration below.
 */

import { registerControl } from "../core/registry.js";
import { commonButtonProperties } from "../core/properties.js";
import { expand, watch } from "../core/variables.js";
import { getGlareSet, createColorFilter } from "../core/glare.js";
import { invoke } from "../core/actions.js";

/*
 * The protocol is optional: a runtime page with no server connection still
 * renders and still runs client actions.  Resolved lazily so importing a
 * control never forces a socket to exist.
 */
let protocolModule;
function getProtocol() {
	return protocolModule && protocolModule.protocol;
}

/** Give controls a protocol to talk to. Called once by the entry point. */
export function useProtocol( mod ) { protocolModule = mod; }

/** Apply text with '_' as a line break, as the original did. */
export function setButtonText( el, text ) {
	el.textContent = "";
	const lines = expand( text ).split( "_" );
	lines.forEach( ( line, i ) => {
		if( i ) el.appendChild( document.createElement( "br" ) );
		el.appendChild( document.createTextNode( line ) );
	} );
}

/**
 * Build the mask / text / lens stack.  Exported so Session and any other
 * button-like control share one implementation.
 */
export function buildButtonFace( el ) {
	const mask = document.createElement( "span" );
	mask.className = "tt-face-mask";

	const label = document.createElement( "span" );
	label.className = "tt-face-text";

	const lens = document.createElement( "span" );
	lens.className = "tt-face-lens";

	el.append( mask, label, lens );

	const filter = createColorFilter();
	mask.style.filter = `url(#${filter.id})`;

	return { mask, label, lens, filter };
}

/** Push colours, images and text onto an existing face. */
export function updateButtonFace( face, props, opts, canvas ) {
	const set = getGlareSet( props.style, canvas ) || getGlareSet( "flat", canvas );
	const { mask, label, lens, filter } = face;

	if( set.css || !set.mask ) {
		// Generated skin: no bitmap, no filter pass.
		mask.style.filter = "";
		mask.style.backgroundImage = "";
		mask.style.backgroundColor = props.color;
		mask.style.border = `2px solid ${props.secondary}`;
		lens.style.backgroundImage = "";
	} else {
		mask.style.filter = `url(#${filter.id})`;
		mask.style.backgroundImage = `url(${JSON.stringify( set.mask )})`;
		mask.style.backgroundColor = "";
		mask.style.border = "";
		// Each channel is driven by whichever property the glare set names;
		// an unused channel resolves to transparent and contributes nothing.
		const roles = set.channels || [ "color", "secondary", "textColor" ];
		filter.setColors( set.shade,
			roles.map( role => ( role ? props[ role ] : null ) ) );
		lens.style.backgroundImage =
			`url(${JSON.stringify( opts && opts.pressed ? set.down : set.up )})`;
	}

	label.style.color = props.textColor;
	// A font preset name resolves through the document; anything else is
	// treated as a literal CSS font shorthand.
	const font = ( canvas && canvas.fontFor( props.font ) ) || props.font;
	if( font ) label.style.font = font;
	if( props.image )
		label.style.backgroundImage = `url(${JSON.stringify( props.image )})`;

	if( label._ttUnwatch ) label._ttUnwatch();
	const render = () => setButtonText( label, props.text );
	render();
	label._ttUnwatch = watch( props.text, render );
}

export function disposeButtonFace( face ) {
	if( face.label._ttUnwatch ) face.label._ttUnwatch();
	face.filter.remove();
}

registerControl( "Button", {
	description: "Common button; colours, glare set, image, page change.",
	properties: commonButtonProperties,

	create( inst ) {
		const el = document.createElement( "button" );
		el.className = "tt-button";
		el._ttFace = buildButtonFace( el );
		el.addEventListener( "click", async () => {
			/*
			 * nextPage stays a first-class property because page changing is the
			 * one behaviour common enough to deserve its own slot -- it is why
			 * the original needed no page-changer control.  Everything else goes
			 * through an action.
			 */
			const next = inst.props.nextPage;
			if( next )
				el.dispatchEvent( new CustomEvent( "tt-navigate",
					{ bubbles: true, detail: { page: next } } ) );

			if( !inst.props.action || inst.props.action === "none" ) return;

			el.disabled = true;
			try {
				const reply = await invoke( inst, {
					element: el,
					protocol: getProtocol(),
					input: {},
				} );
				if( reply && reply.ok === false )
					console.warn( `action refused: ${reply.error}` );
				el.dispatchEvent( new CustomEvent( "tt-invoked",
					{ bubbles: true, detail: { control: inst, reply } } ) );
			} finally {
				el.disabled = false;
			}
		} );
		return el;
	},

	update( el, inst ) {
		updateButtonFace( el._ttFace, inst.props, null,
			inst.page && inst.page.canvas );
	},

	dispose( el ) {
		disposeButtonFace( el._ttFace );
	},
} );
