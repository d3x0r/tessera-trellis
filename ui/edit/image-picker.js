/**
 * @fileoverview Image field: pick from the server, or upload a new one.
 *
 * A document refers to images by URL, so an image it names has to exist on the
 * server — otherwise the layout renders correctly on the machine that made it
 * and nowhere else.  That is why picking and uploading are the same control:
 * choosing a local file uploads it first and stores the returned URL, never a
 * blob: or data: URL that would die with the tab.
 */

let protocolModule;
export function useProtocol( mod ) { protocolModule = mod; }
function proto() { return protocolModule && protocolModule.protocol; }

/** Cached listing; invalidated when anyone uploads. */
let cache = null;
/** The server's upload rules, so the client can refuse before sending. */
let limits = null;

export function invalidateImages() { cache = null; }

export function imageLimits() { return limits; }

export async function knownImages() {
	if( cache ) return cache;
	const p = proto();
	if( !p ) return [];
	try {
		const reply = await p.listImages();
		cache = reply.images || [];
		if( reply.limits ) limits = reply.limits;
	} catch( err ) {
		cache = [];
	}
	return cache;
}

/*
 * A screen's worth of pixels, and no more.
 *
 * A page background is drawn at screen size, so anything past this is pixels
 * nobody will ever see -- still bytes every client downloads before the page
 * can render.  A phone camera produces 48 megapixels and 12MB, and the person
 * handing it over has no reason to know that is a problem, so oversized images
 * are resized rather than refused.
 *
 * A BOUND, best fit: the image is scaled until it fits inside the box, so
 * nothing is ever wider than MAX_WIDTH or taller than MAX_HEIGHT whatever its
 * orientation.  A 6000x8000 portrait becomes 810x1080 -- the height is what
 * binds, and the width follows.
 *
 * Anything that genuinely needs to be larger gets placed in ui/images/ by hand,
 * by someone with server access.  That is the privilege boundary: this path is
 * open to anyone who can open the designer and is deliberately lossy, while the
 * shipped tree is never resized, never deleted by the UI, and requires reaching
 * the filesystem.
 */
const MAX_WIDTH = 1920;
const MAX_HEIGHT = 1080;

/*
 * JPEG quality. Below about 0.65 blocking artifacts start showing on gradients
 * and skin; 0.7 is roughly the last stop before that.
 */
const JPEG_QUALITY = 0.7;

/** Vector; resizing it is meaningless and re-encoding would rasterise it. */
const VECTOR = /\.svg$/i;

/**
 * Shrink an image that is larger than it needs to be.
 *
 * @param {File} file
 * @returns {Promise<{bytes:Uint8Array, name:string, note:string|null}>}
 */
async function prepareImage( file ) {
	const raw = new Uint8Array( await file.arrayBuffer() );
	if( VECTOR.test( file.name ) ) return { bytes: raw, name: file.name, note: null };

	let bitmap;
	try { bitmap = await createImageBitmap( file ); }
	catch( err ) { return { bytes: raw, name: file.name, note: null }; }

	const { width, height } = bitmap;
	const scale = Math.min( 1, MAX_WIDTH / width, MAX_HEIGHT / height );
	if( scale === 1 ) { bitmap.close && bitmap.close(); return { bytes: raw, name: file.name, note: null }; }

	const w = Math.round( width * scale ), h = Math.round( height * scale );
	const canvas = document.createElement( "canvas" );
	canvas.width = w; canvas.height = h;
	const ctx = canvas.getContext( "2d" );
	ctx.imageSmoothingQuality = "high";
	ctx.drawImage( bitmap, 0, 0, w, h );
	bitmap.close && bitmap.close();

	// Keep JPEG as JPEG; anything else may carry alpha, so PNG.
	const jpeg = /\.jpe?g$/i.test( file.name );
	const blob = await new Promise( ( r ) =>
		canvas.toBlob( r, jpeg ? "image/jpeg" : "image/png",
			jpeg ? JPEG_QUALITY : undefined ) );
	if( !blob ) return { bytes: raw, name: file.name, note: null };

	const shrunk = new Uint8Array( await blob.arrayBuffer() );
	// A re-encode is not guaranteed to be smaller; keep whichever is.
	if( shrunk.length >= raw.length )
		return { bytes: raw, name: file.name, note: null };

	const name = jpeg ? file.name : file.name.replace( /\.[^.]+$/, "" ) + ".png";
	return { bytes: shrunk, name,
	         note: `resized ${width}×${height} to ${w}×${h}, `
	             + `${mb( raw.length )} to ${mb( shrunk.length )}` };
}

const mb = ( n ) => n >= 1024 * 1024
	? ( n / 1024 / 1024 ).toFixed( 1 ) + "MB"
	: Math.round( n / 1024 ) + "KB";

/** Say what happened, where the user is actually looking. */
function report( message ) {
	const box = document.createElement( "div" );
	box.className = "tt-image-error";
	box.textContent = message;
	document.body.appendChild( box );
	setTimeout( () => box.remove(), 6000 );
	box.addEventListener( "click", () => box.remove() );
}

/**
 * Build an image field: a dropdown of what the server has, a thumbnail, and an
 * upload button.
 *
 * @param {HTMLElement} form
 * @param {object} obj    object holding the value
 * @param {string} key
 * @param {string} label
 * @param {() => void} onChange
 */
export function buildImageField( form, obj, key, label, onChange ) {
	const div = document.createElement( "div" );
	div.className = "tt-prop-row tt-image-row";
	const name = document.createElement( "label" );
	name.textContent = label;
	div.appendChild( name );

	const thumb = document.createElement( "span" );
	thumb.className = "tt-image-thumb";

	const select = document.createElement( "select" );
	select.className = "tt-prop-text";

	const upload = document.createElement( "button" );
	upload.type = "button";
	upload.className = "tt-revert";
	upload.textContent = "↑";
	upload.title = "Upload an image";

	const file = document.createElement( "input" );
	file.type = "file";
	file.accept = "image/*";
	file.hidden = true;

	const showThumb = () => {
		const url = obj[ key ];
		thumb.style.backgroundImage = url ? `url(${JSON.stringify( url )})` : "";
		thumb.classList.toggle( "tt-image-empty", !url );
	};

	async function fill() {
		const images = await knownImages();
		select.textContent = "";
		const options = [ { url: "", name: "(none)" } ].concat( images );
		// A document may name an image the server no longer has; keep it
		// visible rather than silently snapping the field to something else.
		if( obj[ key ] && !images.some( i => i.url === obj[ key ] ) )
			options.push( { url: obj[ key ], name: obj[ key ] + "  (missing)" } );
		for( const image of options ) {
			const opt = document.createElement( "option" );
			opt.value = image.url;
			opt.textContent = image.name + ( image.builtin ? "" : image.url ? "  ↑" : "" );
			select.appendChild( opt );
		}
		select.value = obj[ key ] || "";
		showThumb();
	}

	select.addEventListener( "change", () => {
		obj[ key ] = select.value;
		showThumb();
		onChange();
	} );

	upload.addEventListener( "click", () => file.click() );

	file.addEventListener( "change", async () => {
		const chosen = file.files && file.files[ 0 ];
		if( !chosen ) return;
		const p = proto();
		if( !p ) return;

		/*
		 * Check the size BEFORE reading and sending.
		 *
		 * The server enforces this too and is the authority, but its check only
		 * runs once the whole file has crossed the wire and been decoded -- an
		 * 11.7MB camera photo took 559ms to travel and parse just to be told no.
		 * The limit comes from the server with the listing so the two cannot
		 * drift out of step.
		 */
		await knownImages();

		upload.disabled = true;
		upload.textContent = "…";
		try {
			// Resize first, so the size check almost never has to say no.
			const prepared = await prepareImage( chosen );

			if( limits && prepared.bytes.length > limits.maxBytes ) {
				report( `"${chosen.name}" is ${mb( prepared.bytes.length )}`
					+ ( prepared.note ? " after resizing" : "" )
					+ `; the limit is ${limits.maxLabel}.` );
				return;
			}

			const reply = await p.putImage( prepared.name, prepared.bytes );
			if( reply && reply.ok ) {
				invalidateImages();
				obj[ key ] = reply.url;
				await fill();
				onChange();
				if( prepared.note ) report( `${reply.name}: ${prepared.note}` );
			} else {
				report( `Upload failed: ${( reply && reply.error ) || "unknown error"}` );
			}
		} finally {
			upload.disabled = false;
			upload.textContent = "↑";
			file.value = "";
		}
	} );

	div.append( thumb, select, upload, file );
	form.appendChild( div );
	fill();
	return div;
}
