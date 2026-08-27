/**
 * @fileoverview Glare sets — the button skin system.
 *
 * A glare set is the original's mask + up + down + glare quartet.  The mask is
 * a three-channel greyscale image: each of R, G and B is an independent
 * coverage mask that gets its own RGBA colour, and the three are composited.
 * The lens layers are mostly-transparent specular that draws *over* the
 * background and over the text, so the text picks up the highlight and the
 * refraction.
 *
 * THE COLOURING IS ONE GPU PASS, NOT A PIXEL LOOP.
 *
 * The browser does have the colour-transform matrix — it is SVG's
 * <feColorMatrix>, reachable from CSS as filter:url(#id), and it is the same
 * 5x4 object as GDI+ ColorMatrix in C#.  Three-channel colourisation is
 * literally a linear transform:
 *
 *     outR = cR.r*inR + cG.r*inG + cB.r*inB
 *     outG = cR.g*inR + cG.g*inG + cB.g*inB
 *     outB = cR.b*inR + cG.b*inG + cB.b*inB
 *     outA = cR.a*inR + cG.a*inG + cB.a*inB
 *
 * which is exactly a feColorMatrix whose first three columns are the three
 * colours.  So 'multi shade' is one matrix, evaluated on the GPU, and a status
 * ring that changes colour is an attribute rewrite — no reprocessing, no
 * canvas readback, and no server round trip.  That is the argument against
 * colourising server-side: a status indicator would otherwise need either an
 * image per state or a request per colour change.
 *
 * Two details that are easy to get wrong:
 *   - color-interpolation-filters must be sRGB.  SVG filters default to
 *     linearRGB, which silently washes the colours out.
 *   - the alpha row derives alpha from the colour channels, so the feComposite
 *     re-clips to the source alpha and keeps the mask's antialiased edge.
 */

/** @type {Map<string,object>} */
const glareSets = new Map();

/**
 * @param {string} name  as used by 'button is <name>'
 * @param {{mask?:string, up?:string, down?:string, glare?:string,
 *          shade?:"mono"|"multi"}} def
 */
export function registerGlareSet( name, def ) {
	glareSets.set( name, Object.assign( { shade: "multi" }, def ) );
}

/**
 * Resolve a glare set.
 *
 * A document may define or override sets of its own; the module registry is
 * only the built-in default, the way the original shipped DEFAULT/round/square
 * and let a config file add to them.
 *
 * @param {string} name
 * @param {object} [canvas]  look here first
 */
export function getGlareSet( name, canvas ) {
	if( canvas && canvas.glares && canvas.glares[ name ] ) return canvas.glares[ name ];
	return glareSets.get( name );
}

/** Built-in names, plus whatever the document adds. */
export function glareSetNames( canvas ) {
	const names = new Set( glareSets.keys() );
	if( canvas && canvas.glares ) for( const n of Object.keys( canvas.glares ) ) names.add( n );
	return [ ...names ].sort();
}

/** Only the built-ins, for "reset to default". */
export function builtinGlareSet( name ) { return glareSets.get( name ); }

// -- colour ---------------------------------------------------------------

/** '#rgb' | '#rrggbb' | '#rrggbbaa' | '$aarrggbb' -> {r,g,b,a} in 0..1 */
export function parseColor( spec ) {
	if( !spec ) return { r: 0, g: 0, b: 0, a: 0 };
	let s = String( spec ).trim();

	// The original config spelled colours $aarrggbb.
	if( s[ 0 ] === "$" ) {
		const v = s.slice( 1 ).padStart( 8, "0" );
		return {
			a: parseInt( v.slice( 0, 2 ), 16 ) / 255,
			r: parseInt( v.slice( 2, 4 ), 16 ) / 255,
			g: parseInt( v.slice( 4, 6 ), 16 ) / 255,
			b: parseInt( v.slice( 6, 8 ), 16 ) / 255,
		};
	}

	if( s[ 0 ] === "#" ) s = s.slice( 1 );
	if( s.length === 3 ) s = s.split( "" ).map( c => c + c ).join( "" );
	if( s.length === 6 ) s += "ff";
	return {
		r: parseInt( s.slice( 0, 2 ), 16 ) / 255,
		g: parseInt( s.slice( 2, 4 ), 16 ) / 255,
		b: parseInt( s.slice( 4, 6 ), 16 ) / 255,
		a: parseInt( s.slice( 6, 8 ), 16 ) / 255,
	};
}

const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 };

/**
 * The feColorMatrix 'values' for a glare set.
 *
 * @param {"mono"|"multi"} shade
 * @param {string[]} colors  multi: [redChannel, greenChannel, blueChannel];
 *                           mono:  [tint]
 * @returns {string} 20 numbers, row-major
 */
export function colorMatrix( shade, colors ) {
	if( shade === "mono" ) {
		// Luminance of the mask scales a single tint.
		const c = parseColor( colors[ 0 ] );
		return [
			c.r * LUMA.r, c.r * LUMA.g, c.r * LUMA.b, 0, 0,
			c.g * LUMA.r, c.g * LUMA.g, c.g * LUMA.b, 0, 0,
			c.b * LUMA.r, c.b * LUMA.g, c.b * LUMA.b, 0, 0,
			c.a * LUMA.r, c.a * LUMA.g, c.a * LUMA.b, 0, 0,
		].map( n => n.toFixed( 5 ) ).join( " " );
	}

	const [ cR, cG, cB ] = [ 0, 1, 2 ].map( i => parseColor( colors[ i ] ) );
	return [
		cR.r, cG.r, cB.r, 0, 0,
		cR.g, cG.g, cB.g, 0, 0,
		cR.b, cG.b, cB.b, 0, 0,
		cR.a, cG.a, cB.a, 0, 0,
	].map( n => n.toFixed( 5 ) ).join( " " );
}

// -- the filter defs ------------------------------------------------------

const SVGNS = "http://www.w3.org/2000/svg";
let defs = null;
let serial = 0;

function ensureDefs() {
	if( defs ) return defs;
	const svg = document.createElementNS( SVGNS, "svg" );
	svg.setAttribute( "width", "0" );
	svg.setAttribute( "height", "0" );
	svg.style.position = "absolute";
	svg.setAttribute( "aria-hidden", "true" );
	defs = document.createElementNS( SVGNS, "defs" );
	svg.appendChild( defs );
	document.body.appendChild( svg );
	return defs;
}

/**
 * A filter whose matrix can be rewritten in place.
 * @returns {{id:string, setColors:(shade:string,colors:string[])=>void, remove:()=>void}}
 */
export function createColorFilter() {
	const id = "tt-glare-" + ( ++serial );
	const filter = document.createElementNS( SVGNS, "filter" );
	filter.setAttribute( "id", id );
	// Filter in sRGB; the linearRGB default washes the colours out.
	filter.setAttribute( "color-interpolation-filters", "sRGB" );

	const matrix = document.createElementNS( SVGNS, "feColorMatrix" );
	matrix.setAttribute( "type", "matrix" );
	matrix.setAttribute( "result", "tinted" );

	// Alpha came from the colour channels; re-clip so the antialiased edge of
	// the mask survives instead of being squared off.
	const clip = document.createElementNS( SVGNS, "feComposite" );
	clip.setAttribute( "in", "tinted" );
	clip.setAttribute( "in2", "SourceGraphic" );
	clip.setAttribute( "operator", "in" );

	filter.appendChild( matrix );
	filter.appendChild( clip );
	ensureDefs().appendChild( filter );

	return {
		id,
		setColors( shade, colors ) {
			matrix.setAttribute( "values", colorMatrix( shade, colors ) );
		},
		remove() { filter.remove(); },
	};
}

// -- stock sets -----------------------------------------------------------

/*
 * 'bicolor square' from the original config: colorLayer.png is the 3-channel
 * mask, defaultLens/pressedLens are the specular layers.
 */
registerGlareSet( "bicolor square", {
	mask: "images/colorLayer.png",
	up:   "images/defaultLens.png",
	down: "images/pressedLens.png",
	shade: "multi",
	/*
	 * Which button property drives each channel of the mask.  Measured from
	 * colorLayer.png: mean RGB is (0,48,146) and no pixel has both R and G
	 * lit, so the channels are disjoint coverage masks and RED IS UNUSED.
	 * G is the ring, B is the body -- which matches the original config,
	 * where 'Enable Participant' set secondary color=$FF00FF00 to make the
	 * ring bright green.  That ring is the status indicator: recolouring it
	 * is one attribute rewrite on the matrix.
	 */
	channels: [ null, "secondary", "color" ],
} );

registerGlareSet( "round", {
	mask: "images/round_mask.png",
	up:   "images/round_ridge_up.png",
	down: "images/round_ridge_down.png",
	shade: "mono",
	channels: [ "color" ],
} );

/*
 * A glare set need not be images at all.  For a plain rounded rect, CSS is
 * sharper at every size and cheaper than a filtered bitmap; the registry holds
 * both kinds so art-directed and generated skins are interchangeable.
 */
registerGlareSet( "flat", { css: true, shade: "multi" } );
