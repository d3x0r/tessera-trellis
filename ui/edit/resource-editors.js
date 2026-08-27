/**
 * @fileoverview Font preset and glare set editors.
 *
 * These are the C editor's MNU_EDIT_FONTS and MNU_EDIT_GLARES, and like it they
 * edit DOCUMENT data: the original kept both in the config file
 * (`font preset Label Font={...}`, `round button up=images/...`), not in code.
 *
 * So the module-level glare registry is only a set of built-in defaults now; a
 * document may add its own or shadow a built-in by name, and that is what these
 * panels write to.  Editing is live — every control using the preset repaints
 * as you type, same as style presets.
 */

import { popups } from "@d3x0r/popups2";
import "@d3x0r/popups2/controls/text-input.js";
import { createSimpleForm } from "@d3x0r/popups2/forms/simple-form.js";
import { createSimpleNotice } from "@d3x0r/popups2/forms/simple-notice.js";
import { glareSetNames, builtinGlareSet, getGlareSet } from "../core/glare.js";
import { buildImageField } from "./image-picker.js";

/** One panel per resource kind, so a second request raises rather than stacks. */
const open = new Map();

function ask( title, question, value, ok ) {
	const form = createSimpleForm( title, question, value,
		( v ) => { const name = ( v || "" ).trim(); if( name ) ok( name ); },
		null, { modal: true } );
	form.show();
	return form;
}

/** Informational, single Okay — createSimpleNotice omits Cancel without a cb. */
function tell( title, message ) {
	const notice = createSimpleNotice( title, message, () => {}, undefined,
		{ modal: true } );
	notice.show();
	return notice;
}

/** Okay / Cancel. */
function confirm( title, question, yes ) {
	const notice = createSimpleNotice( title, question, yes, () => {},
		{ modal: true } );
	notice.show();
	return notice;
}

/** "3 controls and style 'Danger'" */
function describeUsage( usage ) {
	const parts = [];
	if( usage.controls.length )
		parts.push( `${usage.controls.length} control${usage.controls.length === 1 ? "" : "s"}` );
	if( usage.styles.length )
		parts.push( `style preset${usage.styles.length === 1 ? "" : "s"} `
			+ usage.styles.map( n => `'${n}'` ).join( ", " ) );
	return parts.join( " and " );
}

/**
 * @param {string} key      identity, so a second request raises rather than stacks
 * @param {string} caption
 * @param {?{x:number,y:number}} near
 * @param {?object} track   undo descriptor:
 *                          { history, label, entries:[ {kind,target,key} ] }
 *                          A LIST because one panel can span more than one
 *                          entity -- page properties edits the page and the
 *                          canvas-level idle timeout in the same session.
 */
function panel( key, caption, near, track ) {
	const existing = open.get( key );
	if( existing ) {
		if( typeof existing.raise === "function" ) existing.raise();
		return { popup: existing, reused: true };
	}
	const popup = popups.create( caption );
	open.set( key, popup );

	/*
	 * These editors apply live and have no Cancel, so one undo entry per
	 * session is the right grain: snapshot on open, record on close, and an
	 * unchanged session records nothing because before and after match.
	 */
	const capture = ( e ) => {
		if( e.kind === "page" ) return track.history.capturePage( e.target );
		if( e.kind === "pageOrder" ) return track.history.capturePageOrder( e.target );
		return track.history.captureCanvas( e.target, e.key );
	};
	const before = track && track.history
		? track.entries.map( e => ( { ...e, before: capture( e ) } ) )
		: null;

	/*
	 * Listen for BOTH events.  For a non-modal popup hide() raises only
	 * "hide", never "close" -- so a Done button calling hide() left the entry
	 * in `open`, and the next request raise()d a hidden popup instead of
	 * building a fresh one.  The menu item simply stopped working after the
	 * first use.
	 */
	let settled = false;
	const finish = () => {
		if( settled ) return;
		settled = true;
		open.delete( key );
		// Unchanged entities drop out inside record(), so a session that only
		// touched the page does not also push an empty canvas record.
		if( track && track.history ) track.history.record( track.label, before );
		/*
		 * hide() only sets display:none, and these panels are rebuilt from the
		 * document each time they open -- so without this every close leaves
		 * another dead frame behind, and any query for ".tt-prop-text" starts
		 * matching stale copies as well as the live one.
		 */
		popup.remove();
	};
	popup.on( "hide", finish );
	popup.on( "close", finish );

	const body = document.createElement( "div" );
	body.className = "tt-prop-form";
	popup.divContent.appendChild( body );

	popup.show();
	if( near ) {
		const frame = popup.divFrame;
		const w = frame.offsetWidth || 380, h = frame.offsetHeight || 320;
		frame.style.left = Math.max( 8, Math.min( near.x + 24, window.innerWidth - w - 8 ) ) + "px";
		frame.style.top  = Math.max( 8, Math.min( near.y, window.innerHeight - h - 8 ) ) + "px";
	}
	return { popup, body, reused: false };
}

function row( form, label ) {
	const div = document.createElement( "div" );
	div.className = "tt-prop-row";
	const name = document.createElement( "label" );
	name.textContent = label;
	div.appendChild( name );
	form.appendChild( div );
	return div;
}

function textRow( form, label, value, onInput, placeholder ) {
	const div = row( form, label );
	const input = document.createElement( "input" );
	input.className = "tt-prop-text";
	input.value = value || "";
	if( placeholder ) input.placeholder = placeholder;
	input.addEventListener( "input", () => onInput( input.value ) );
	div.appendChild( input );
	return input;
}

function footer( form, popup, ...extra ) {
	const bar = document.createElement( "div" );
	bar.className = "tt-prop-buttons";
	for( const button of extra ) if( button ) bar.appendChild( button );
	const done = document.createElement( "button" );
	done.textContent = "Done";
	done.addEventListener( "click", () => popup.hide() );
	bar.appendChild( done );
	form.parentElement.appendChild( bar );
}

// -- fonts -----------------------------------------------------------------

/**
 * Edit the document's font presets.
 *
 * A preset is a CSS font shorthand. Controls reference it by name, so changing
 * "Label Font" here restyles every label using it — which is the whole reason
 * the original had presets rather than per-button font settings.
 *
 * @param {object} canvas
 * @param {{onChange:()=>void, near?:{x:number,y:number}}} opts
 */
export function editFontPresets( canvas, opts ) {
	const got = panel( "fonts", "Font presets", opts.near,
		{ history: opts.history, label: "Edit fonts",
		  entries: [ { kind: "canvas", target: canvas, key: "fonts" } ] } );
	if( got.reused ) return got.popup;
	const { popup, body } = got;

	const changed = () => opts.onChange && opts.onChange();

	function build() {
		body.textContent = "";

		const names = canvas.fontNames();
		if( !names.length ) {
			const note = document.createElement( "div" );
			note.className = "tt-args-empty";
			note.textContent = "(no presets yet)";
			body.appendChild( note );
		}

		for( const name of names ) {
			const preset = canvas.fonts[ name ];
			const input = textRow( body, name, preset.font,
				( v ) => { preset.font = v; changed(); },
				"e.g.  600 2.6vh/1.2 system-ui, sans-serif" );

			// Live preview in the field itself; a font is hard to judge by its text.
			const apply = () => { input.style.font = preset.font || ""; };
			apply();
			input.addEventListener( "input", apply );

			const drop = document.createElement( "button" );
			drop.className = "tt-revert";
			drop.type = "button";
			drop.textContent = "✕";
			drop.title = `Delete ${name}`;
			drop.addEventListener( "click", () => {
				/*
				 * Refuse while anything still references it.  Deleting a preset
				 * in use does not fail loudly -- the reference just stops
				 * resolving and the text silently reverts to the browser
				 * default, which is easy to miss and hard to trace back.
				 */
				const usage = canvas.fontUsage( name );
				if( usage.controls.length || usage.styles.length ) {
					tell( "Font preset in use",
						`'${name}' is used by ${describeUsage( usage )}.

`
						+ "Point them at another preset first." );
					return;
				}
				confirm( "Delete font preset", `Delete '${name}'?`, () => {
					delete canvas.fonts[ name ];
					changed();
					build();
				} );
			} );
			body.lastElementChild.appendChild( drop );
		}
	}
	build();

	const add = document.createElement( "button" );
	add.textContent = "New preset...";
	add.addEventListener( "click", () => {
		ask( "New font preset", "Name for the preset",
			`Font ${canvas.fontNames().length + 1}`, ( name ) => {
				canvas.fonts[ name ] = { font: "400 2.4vh/1.2 system-ui, sans-serif" };
				changed();
				build();
			} );
	} );

	footer( body, popup, add );
	popup.sync = build;
	return popup;
}

// -- glare sets ------------------------------------------------------------

const GLARE_FIELDS = [
	[ "mask", "Mask image", "3-channel; each channel takes one colour" ],
	[ "up",   "Lens (up)",  "specular drawn over the text" ],
	[ "down", "Lens (down)","specular while pressed" ],
];

/**
 * Edit glare sets.
 *
 * Built-ins are read-only until edited; the first edit copies the set into the
 * document, which then shadows the built-in by name.  That is the same
 * behaviour the original config had, where a file could redefine `round` and
 * everything referencing `round` picked up the change.
 *
 * @param {object} canvas
 * @param {{onChange:()=>void, near?:{x:number,y:number}}} opts
 */
export function editGlareSets( canvas, opts ) {
	const got = panel( "glares", "Button glares", opts.near,
		{ history: opts.history, label: "Edit button glares",
		  entries: [ { kind: "canvas", target: canvas, key: "glares" } ] } );
	if( got.reused ) return got.popup;
	const { popup, body } = got;

	let selected = glareSetNames( canvas )[ 0 ] || "";
	const changed = () => opts.onChange && opts.onChange();

	/** Copy a built-in into the document so it can be edited. */
	function editable( name ) {
		if( !canvas.glares[ name ] ) {
			const base = builtinGlareSet( name );
			canvas.glares[ name ] = base
				? JSON.parse( JSON.stringify( base ) )
				: { shade: "multi", channels: [ null, "secondary", "color" ] };
		}
		return canvas.glares[ name ];
	}

	function build() {
		body.textContent = "";

		const pick = row( body, "Glare set" );
		const sel = document.createElement( "select" );
		sel.className = "tt-prop-text";
		for( const name of glareSetNames( canvas ) ) {
			const opt = document.createElement( "option" );
			opt.value = name;
			opt.textContent = name + ( canvas.glares[ name ] ? "  (document)" : "" );
			sel.appendChild( opt );
		}
		sel.value = selected;
		sel.addEventListener( "change", () => { selected = sel.value; build(); } );
		pick.appendChild( sel );

		const set = getGlareSet( selected, canvas );
		if( !set ) return;

		const note = document.createElement( "div" );
		note.className = "tt-args-empty";
		note.textContent = canvas.glares[ selected ]
			? "defined by this document"
			: "built-in — editing copies it into the document";
		body.appendChild( note );

		if( set.css ) {
			const gen = document.createElement( "div" );
			gen.className = "tt-args-empty";
			gen.textContent = "generated in CSS; no images to set";
			body.appendChild( gen );
		} else {
			for( const [ key, label ] of GLARE_FIELDS ) {
				// Bind through a shim so the first edit copies the built-in set
				// into the document rather than mutating the module registry.
				const shim = {
					get [ key ]() { return set[ key ]; },
					set [ key ]( v ) { editable( selected )[ key ] = v; },
				};
				buildImageField( body, shim, key, label, changed );
			}
		}

		// Which button property drives each mask channel.
		const roles = ( set.channels || [ "color", "secondary", "textColor" ] );
		for( const [ i, chan ] of [ "Red", "Green", "Blue" ].entries() ) {
			const div = row( body, chan + " channel" );
			const rs = document.createElement( "select" );
			rs.className = "tt-prop-text";
			for( const role of [ "", "color", "secondary", "textColor" ] ) {
				const opt = document.createElement( "option" );
				opt.value = role;
				opt.textContent = role || "(unused)";
				rs.appendChild( opt );
			}
			rs.value = roles[ i ] || "";
			rs.addEventListener( "change", () => {
				const target = editable( selected );
				const next = ( target.channels || roles ).slice();
				next[ i ] = rs.value || null;
				target.channels = next;
				changed();
			} );
			div.appendChild( rs );
		}
	}
	build();

	const remove = document.createElement( "button" );
	remove.textContent = "Delete set...";
	remove.addEventListener( "click", () => {
		if( !canvas.glares[ selected ] ) {
			tell( "Built-in glare set",
				`'${selected}' is built in and cannot be deleted.

`
				+ "Only sets this document defines can be removed." );
			return;
		}
		const usage = canvas.glareUsage( selected );
		if( usage.controls.length || usage.styles.length ) {
			tell( "Glare set in use",
				`'${selected}' is used by ${describeUsage( usage )}.

`
				+ "Point them at another set first." );
			return;
		}
		const name = selected;
		confirm( "Delete glare set", `Delete '${name}'?`, () => {
			delete canvas.glares[ name ];
			selected = glareSetNames( canvas )[ 0 ] || "";
			changed();
			build();
		} );
	} );

	const add = document.createElement( "button" );
	add.textContent = "New set...";
	add.addEventListener( "click", () => {
		ask( "New glare set", "Name for the glare set",
			`Glare ${Object.keys( canvas.glares ).length + 1}`, ( name ) => {
				canvas.glares[ name ] = { shade: "multi",
					channels: [ null, "secondary", "color" ] };
				selected = name;
				changed();
				build();
			} );
	} );

	footer( body, popup, add, remove );
	popup.sync = build;
	return popup;
}

// -- page properties -------------------------------------------------------

/**
 * Edit the current page's background.
 *
 * The C editor's MNU_PAGE_PROPERTIES.  Colour shows through wherever the image
 * does not cover, which is also what you see while the image is still loading,
 * so both are worth setting even when an image is present.
 *
 * @param {object} page
 * @param {{onChange:()=>void, near?:{x:number,y:number}}} opts
 */
export function editPageProperties( page, opts ) {
	const got = panel( "page:" + page.title, `Page \u2014 ${page.title}`, opts.near,
		{ history: opts.history, label: "Page properties",
		  entries: [ { kind: "page", target: page },
		             { kind: "canvas", target: page.canvas, key: "idle" } ] } );
	if( got.reused ) return got.popup;
	const { popup, body } = got;

	const changed = () => opts.onChange && opts.onChange();

	// Colour well plus hex, same as the property panel.
	const div = row( body, "Background" );
	const well = document.createElement( "input" );
	well.type = "color";
	well.value = /^#[0-9a-f]{6}$/i.test( page.background.color || "" )
		? page.background.color : "#000000";
	const hex = document.createElement( "input" );
	hex.className = "tt-prop-text";
	hex.value = page.background.color || "";

	const push = ( v ) => { page.background.color = v; changed(); };
	well.addEventListener( "input", () => { hex.value = well.value; push( well.value ); } );
	hex.addEventListener( "change", () => {
		if( /^#[0-9a-f]{6}$/i.test( hex.value ) ) well.value = hex.value;
		push( hex.value );
	} );
	div.append( well, hex );

	buildImageField( body, page.background, "image", "Background image", changed );

	/*
	 * A looping video background -- what a screen-saver page is.  A plain URL
	 * rather than the image picker, because that picker uploads to the image
	 * store and a video is a different kind of asset with different limits.
	 *
	 * It plays over the background colour and under every control, muted (the
	 * only way a browser will autoplay it) and paused while editing.
	 */
	const videoRow = row( body, "Background video" );
	const videoUrl = document.createElement( "input" );
	videoUrl.className = "tt-prop-text";
	videoUrl.value = page.background.video || "";
	videoUrl.placeholder = "URL of a video file";
	videoUrl.addEventListener( "change", () => {
		page.background.video = videoUrl.value.trim();
		changed();
	} );
	videoRow.appendChild( videoUrl );

	const loopRow = row( body, "Loop video" );
	const loop = document.createElement( "input" );
	loop.type = "checkbox";
	loop.checked = page.background.videoLoop !== false;
	loop.addEventListener( "change", () => {
		page.background.videoLoop = loop.checked;
		changed();
	} );
	loopRow.appendChild( loop );

	/*
	 * Screen saver. The flag lives on the PAGE so renaming it cannot detach the
	 * screen saver, and the timeout on the canvas because there is one shell.
	 *
	 * Several pages may be marked: they are shown in turn, each for its own
	 * duration, so an attract loop is built out of ordinary pages instead of a
	 * special slideshow control. Page order is loop order.
	 */
	/*
	 * A fragment loaded into a shadow root on this page, behind the controls.
	 * NOT an iframe: it runs in the shell's realm, so it can call shell APIs
	 * and its input reaches the idle watcher directly -- and it has no sandbox
	 * and no origin boundary, so it is for content you control. Same-origin or
	 * CORS, because it is fetched.
	 */
	const embedRow = row( body, "Embed fragment" );
	const embed = document.createElement( "input" );
	embed.className = "tt-prop-text";
	embed.title = "HTML fragment URL; runs in the shell, not sandboxed";
	embed.placeholder = "URL of an HTML fragment";
	if( !page.embed ) page.embed = { url: "", origin: "" };
	embed.value = page.embed.url || "";
	embed.addEventListener( "change", () => {
		page.embed.url = embed.value.trim();
		changed();
	} );
	embedRow.appendChild( embed );

	const saverRow = row( body, "Screensaver page" );
	const saver = document.createElement( "input" );
	saver.type = "checkbox";
	saver.checked = !!page.screensaver;
	saverRow.appendChild( saver );

	const holdRow = row( body, "Show for (s)" );
	const hold = document.createElement( "input" );
	hold.className = "tt-prop-text";
	hold.type = "number";
	hold.min = "0";
	hold.step = "1";
	hold.title = "0 holds this page until activity; only matters with several"
		+ " screensaver pages";
	hold.value = Number( page.screensaverSeconds ) || 0;
	hold.addEventListener( "change", () => {
		page.screensaverSeconds = Math.max( 0, Number( hold.value ) || 0 );
		changed();
	} );
	holdRow.appendChild( hold );

	/** The hold time only means anything for a page in the loop. */
	const syncHold = () => { holdRow.style.opacity = saver.checked ? "" : ".5"; };
	syncHold();
	saver.addEventListener( "change", () => {
		page.screensaver = saver.checked;
		syncHold();
		changed();
	} );

	const idleRow = row( body, "Idle timeout (min)" );
	const idle = document.createElement( "input" );
	idle.className = "tt-prop-text";
	idle.type = "number";
	idle.min = "0";
	idle.step = "1";
	idle.title = "0 disables it; expect hours rather than minutes";
	idle.value = ( page.canvas && page.canvas.idle && page.canvas.idle.minutes ) || 0;
	idle.addEventListener( "change", () => {
		const canvas = page.canvas;
		if( !canvas ) return;
		if( !canvas.idle ) canvas.idle = { minutes: 0 };
		canvas.idle.minutes = Math.max( 0, Number( idle.value ) || 0 );
		changed();
	} );
	idleRow.appendChild( idle );

	footer( body, popup );
	popup.sync = () => {};
	return popup;
}

// -- page order ------------------------------------------------------------

/**
 * Reorder the pages.
 *
 * Page order stopped being cosmetic once it became the attract loop's order and
 * what `(next)` steps through, so it needs somewhere to be seen and changed as
 * a whole rather than inferred from a dropdown.
 *
 * @param {Canvas} canvas
 * @param {{onChange?:Function, showPage?:Function, near?:{x,y}, history?:object}} opts
 */
export function editPageOrder( canvas, opts ) {
	const got = panel( "pages", "Pages", opts.near,
		{ history: opts.history, label: "Reorder pages",
		  entries: [ { kind: "pageOrder", target: canvas } ] } );
	if( got.reused ) return got.popup;
	const { popup, body } = got;

	const changed = () => opts.onChange && opts.onChange();

	function build() {
		body.textContent = "";
		const live = canvas.livePages();

		if( !live.length ) {
			const note = document.createElement( "div" );
			note.className = "tt-args-empty";
			note.textContent = "(no pages)";
			body.appendChild( note );
			return;
		}

		live.forEach( ( page, index ) => {
			const rowEl = document.createElement( "div" );
			rowEl.className = "tt-page-row";

			const name = document.createElement( "button" );
			name.type = "button";
			name.className = "tt-page-name";
			name.textContent = page.title;
			name.title = "Show this page";
			name.addEventListener( "click", () => opts.showPage && opts.showPage( page ) );
			if( opts.currentPage && opts.currentPage() === page )
				rowEl.classList.add( "tt-page-current" );

			/*
			 * Mark the attract loop inline: its order IS this order, so seeing
			 * which rows belong to it is the difference between reordering
			 * pages and reordering the loop.
			 */
			const marks = document.createElement( "span" );
			marks.className = "tt-page-marks";
			if( page.screensaver ) {
				const secs = Number( page.screensaverSeconds ) || 0;
				marks.textContent = secs > 0 ? `screensaver ${secs}s` : "screensaver";
			}

			const up = document.createElement( "button" );
			up.type = "button";
			up.className = "tt-revert";
			up.textContent = "↑";
			up.title = "Move earlier";
			up.disabled = index === 0;
			up.addEventListener( "click", () => {
				if( canvas.movePage( page, -1 ) ) { build(); changed(); }
			} );

			const down = document.createElement( "button" );
			down.type = "button";
			down.className = "tt-revert";
			down.textContent = "↓";
			down.title = "Move later";
			down.disabled = index === live.length - 1;
			down.addEventListener( "click", () => {
				if( canvas.movePage( page, 1 ) ) { build(); changed(); }
			} );

			rowEl.append( name, marks, up, down );
			body.appendChild( rowEl );
		} );
	}

	build();
	popup.sync = () => build();
	footer( body, popup );
	return popup;
}
