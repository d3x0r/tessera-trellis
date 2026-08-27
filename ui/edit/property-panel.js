/**
 * @fileoverview The property panel — a form generated from a schema.
 *
 * This is the piece that pays for declaring `properties` on every control.  The
 * C version wrote a dialog by hand per control (clock_addon.c spent ~70 lines
 * on GetControl/SetCheckState/GetCheckState pairs, mirrored in both
 * directions); here one builder serves every control that will ever exist,
 * including ones a plugin adds after this file was written.
 *
 * Uses popups2's controls, which bind as (form, object, field, label) -- the
 * exact shape a schema walk produces, since the props object is the object and
 * the schema key is the field.
 *
 * Text uses makeTextInput, NOT makeTextField: the latter renders a read-only
 * SPAN and its handler does setValue(..., control.value, ...), which on a SPAN
 * is undefined, so editing one writes undefined into the bound field.
 * makeNameInput is display-plus-rename-dialog, which is too heavy for a grid.
 * Colour keeps a native <input type=color>, because a text box is a miserable
 * way to pick a colour.
 *
 * Edits apply live, because seeing the button change colour as you pick it is
 * the entire point of a designer.  Cancel restores the snapshot taken on open.
 */

import { popups } from "@d3x0r/popups2";
import "@d3x0r/popups2/controls/text-input.js";
import "@d3x0r/popups2/controls/checkbox.js";
import "@d3x0r/popups2/controls/choice-input.js";

import { PropType, commonButtonProperties } from "../core/properties.js";
import { getControlDef } from "../core/registry.js";
import { glareSetNames } from "../core/glare.js";
import { getAction, actionNames } from "../core/actions.js";
import { commonButtonProperties as COMMON } from "../core/properties.js";
import { buildImageField } from "./image-picker.js";

/*
 * The two menu entries are a PARTITION, not a subset and a superset:
 *
 *   Edit General -> the common button properties (colours, text, glare set...)
 *   Edit         -> what is specific to THIS control type (its action, its
 *                   source, a clock's analog flag)
 *
 * That is the C split: OnConfigureControl was the control's own dialog, and
 * SetCommonButtonControls handled the shared half.  Showing everything under
 * "Edit" made the specific handful hard to find among a dozen common ones.
 *
 * Derived from commonButtonProperties rather than a hand-written list, so the
 * two halves cannot drift apart when that set changes.
 */
const GENERAL = new Set( Object.keys( commonButtonProperties ) );

/**
 * A schema may state its own `group`; membership in the common set is only the
 * fallback.  Behaviour properties are shared by every button and are still the
 * specific thing you open one to change.
 *
 * @returns {{general:object, specific:object}}
 */
export function splitProperties( def ) {
	const general = {}, specific = {};
	for( const [ key, spec ] of Object.entries( ( def && def.properties ) || {} ) ) {
		const group = spec.group || ( GENERAL.has( key ) ? "general" : "specific" );
		( group === "general" ? general : specific )[ key ] = spec;
	}
	return { general, specific };
}

/** Does this control type have anything under each heading? */
export function propertyGroups( def ) {
	const { general, specific } = splitProperties( def );
	return { hasGeneral: !!Object.keys( general ).length,
	         hasSpecific: !!Object.keys( specific ).length };
}

/*
 * One panel per control per half.  Asking for a second copy raises the one that
 * is already open instead of stacking duplicates that would fight over the same
 * props object.
 */
const openPanels = new Map();

/**
 * Which values a Choice property may take.
 *
 * `from` names a live list rather than a fixed one, so a plugin's source or
 * glare set appears here without this file knowing it exists.
 */
function choicesFor( spec, ctx ) {
	if( Array.isArray( spec.choices ) ) return spec.choices.slice();
	switch( spec.from ) {
	case "glareSets": return glareSetNames( ctx.canvas );
	case "fonts":     return [ "" ].concat( ctx.canvas ? ctx.canvas.fontNames() : [] );
	case "sources":   return ctx.sources || [];
	case "actions":   return actionNames();
	default:          return [];
	}
}

/** A labelled row; every field shares this shape. */
function row( form, label ) {
	const div = document.createElement( "div" );
	div.className = "tt-prop-row";
	const name = document.createElement( "label" );
	name.textContent = label;
	div.appendChild( name );
	form.appendChild( div );
	return div;
}

function buildText( form, obj, key, label, onChange, isNumber ) {
	// (form, object, field, label, money, percent, number)
	const field = popups.makeTextInput( form, obj, key, label,
		false, false, !!isNumber );
	// The control writes the bound field itself; we only need to react.
	field.addEventListener( "input",  () => onChange( key ) );
	field.addEventListener( "change", () => onChange( key ) );
	return field;
}

/*
 * popups2's Checkbox used to ignore opts.change (only .on("change") populated
 * its listeners) AND its input-level change handler stored the value without
 * firing them -- so ticking the box updated the model, left the live preview
 * stale, and never entered this panel's `touched` set, meaning Cancel would
 * not restore it. Both are fixed upstream; this is the plain spelling again,
 * matching every other field here.
 */
function buildBool( form, obj, key, label, onChange ) {
	return popups.makeCheckbox( form, obj, key, label, { change: () => onChange( key ) } );
}

function buildSelect( form, obj, key, label, choices, onChange ) {
	const list = choices.map( c => typeof c === "string"
		? { text: c || "(none)", value: c } : c );
	return popups.makeChoiceInput( form, obj, key, list, label, { change: () => onChange( key ) } );
}

/**
 * Mark a row with where its value came from, and offer to drop a local
 * override.  Without this a cascade is guesswork: you cannot tell whether a
 * colour is the preset's or this control's, and there is no way back once you
 * have typed over it.
 */
function markOrigin( rowEl, control, key, onRevert ) {
	if( !rowEl || !control || typeof control.originOf !== "function" ) return;
	const origin = control.originOf( key );

	rowEl.classList.toggle( "tt-from-preset", origin === "preset" );
	rowEl.classList.toggle( "tt-overridden", origin === "local" && !!control.preset );

	const style = control.style;
	const governed = style && style.governs( key );
	if( origin !== "local" || !governed ) return;

	const revert = document.createElement( "button" );
	revert.className = "tt-revert";
	revert.type = "button";
	revert.textContent = "↺";
	revert.title = `Revert to ${control.preset}`;
	revert.addEventListener( "click", ( e ) => {
		e.preventDefault();
		control.revert( key );
		onRevert();
	} );
	rowEl.appendChild( revert );
}

/** Build one field. Returns false when the type has no editor yet. */
function buildField( form, props, key, spec, ctx, onChange ) {
	const label = spec.label || key;

	switch( spec.type ) {
	case PropType.Bool:
		buildBool( form, props, key, label, onChange );
		return true;

	case PropType.Choice:
		buildSelect( form, props, key, label, choicesFor( spec, ctx ), onChange );
		return true;

	case PropType.Page:
		/*
		 * Symbolic targets first, then real pages. "(next)" and friends survive
		 * a page being renamed or added, which a title cannot -- and they are
		 * what an attract loop needs to step itself along.
		 */
		buildSelect( form, props, key, label,
			[ "" ].concat( ctx.canvas.constructor.PAGE_TOKENS || [] )
			      .concat( ctx.canvas.pageTitles() ), onChange );
		return true;

	case PropType.Action:
		// Changing the action changes which arguments exist, so rebuild.
		buildSelect( form, props, key, label, actionNames(),
			() => { onChange( key ); ctx.rebuild(); } );
		return true;

	case PropType.Args:
		buildArgs( form, props, key, spec, ctx, onChange );
		return true;

	case PropType.Security:
		buildSecurity( form, props, key, label, onChange );
		return true;

	case PropType.Color:
		buildColor( form, props, key, label, onChange );
		return true;

	case PropType.Image:
		buildImageField( form, props, key, label, () => onChange( key ) );
		return true;

	case PropType.Font:
		buildSelect( form, props, key, label, choicesFor( spec, ctx ), onChange );
		return true;

	case PropType.Number:
		buildText( form, props, key, label, onChange, "number" );
		return true;

	default:
		// string, image and font all edit as text for now.
		buildText( form, props, key, label, onChange );
		return true;
	}
}

/**
 * A sub-form for actionArgs / sourceArgs.
 *
 * The schema is not known here: it comes from whichever action or source the
 * sibling property selected.  That indirection is what lets a button be wired
 * to a plugin's action entirely in the UI.
 */
function buildArgs( form, props, key, spec, ctx, onChange ) {
	const schema = ctx.argsSchemaFor && ctx.argsSchemaFor( key );
	const box = document.createElement( "fieldset" );
	box.className = "tt-args";
	const legend = document.createElement( "legend" );
	legend.textContent = spec.label || key;
	box.appendChild( legend );
	form.appendChild( box );

	if( !schema || !Object.keys( schema ).length ) {
		const note = document.createElement( "div" );
		note.className = "tt-args-empty";
		note.textContent = "(nothing to configure)";
		box.appendChild( note );
		return;
	}

	/*
	 * Clone on write.  props[key] may be coming from a preset, and mutating that
	 * object in place would edit the preset itself -- changing every control
	 * that references it, from a panel that is only meant to touch this one.
	 */
	props[ key ] = Object.assign( {}, props[ key ] );
	const bag = props[ key ];

	for( const [ name, sub ] of Object.entries( schema ) ) {
		if( !( name in bag ) ) bag[ name ] = sub.default !== undefined ? sub.default : "";
		buildField( box, bag, name, sub, ctx, onChange );
	}
}

function buildSecurity( form, props, key, label, onChange ) {
	if( !props[ key ] ) props[ key ] = { tokens: [] };
	const div = row( form, label + " (tokens)" );
	const input = document.createElement( "input" );
	input.className = "tt-prop-text";
	input.placeholder = "comma separated";
	input.value = ( props[ key ].tokens || [] ).join( ", " );
	input.addEventListener( "input", () => {
		props[ key ].tokens = input.value.split( "," )
			.map( t => t.trim() ).filter( Boolean );
		onChange( key );
	} );
	div.appendChild( input );
}

/** A real colour well; text alone is miserable for picking a colour. */
function buildColor( form, props, key, label, onChange ) {
	const div = row( form, label );

	const well = document.createElement( "input" );
	well.type = "color";
	// <input type=color> only understands #rrggbb.
	well.value = /^#[0-9a-f]{6}$/i.test( props[ key ] || "" ) ? props[ key ] : "#000000";

	const text = document.createElement( "input" );
	text.className = "tt-prop-text";
	text.value = props[ key ] || "";

	const push = ( v ) => { props[ key ] = v; onChange( key ); };
	well.addEventListener( "input", () => { text.value = well.value; push( well.value ); } );
	text.addEventListener( "change", () => {
		if( /^#[0-9a-f]{6}$/i.test( text.value ) ) well.value = text.value;
		push( text.value );
	} );

	div.append( well, text );
}

/**
 * Open the panel for one control.
 *
 * @param {Control} control
 * @param {object}  opts
 * @param {boolean} [opts.generalOnly]  the C editor's "Edit General"
 * @param {object}  opts.canvas
 * @param {string[]} [opts.sources]     source names the server offers
 * @param {() => void} opts.onChange    apply the live edit
 */
export function editControlProperties( control, opts ) {
	const def = getControlDef( control.type );
	if( !def || !def.properties ) {
		console.warn( `control type '${control.type}' declares no properties` );
		return null;
	}

	const key = control.id + ":" + ( opts.generalOnly ? "general" : "specific" );
	const already = openPanels.get( key );
	if( already ) {
		// popups2's tracker installs raise(); it is a no-op for popovers.
		if( typeof already.raise === "function" ) already.raise();
		const first = already.divContent.querySelector( "input,select,textarea" );
		if( first ) first.focus();
		return already;
	}

	const fields = opts.generalOnly ? splitProperties( def ).general
	                                : splitProperties( def ).specific;
	if( !Object.keys( fields ).length ) {
		console.warn( `${control.type} has no ${opts.generalOnly ? "general" : "specific"} properties` );
		return null;
	}

	const popup = popups.create( control.type
		+ ( opts.generalOnly ? " — general" : " properties" ) );

	/*
	 * Snapshot the LOCAL overrides, never control.props.  props is the resolved
	 * view, so restoring a copy of it would write every inherited value into
	 * own and silently detach the control from its preset -- which would look
	 * correct until someone edited the preset and nothing moved.
	 */
	const before = JSON.parse( JSON.stringify( control.own ) );

	/*
	 * One undo entry for the whole panel session.  The panel keeps applying
	 * every change live; the transaction only decides how much of that reads
	 * as a single operation afterwards -- which is what makes live editing and
	 * a sane undo stack compatible rather than opposed.
	 *
	 * touch() here captures the pre-dialog state; commit() on Okay captures
	 * where it ended up, and drops the entry entirely if nothing changed.
	 */
	const history = opts.history || null;
	const snapshot = history ? history.capture( control ) : null;

	const form = document.createElement( "div" );
	form.className = "tt-prop-form";
	popup.divContent.appendChild( form );

	/*
	 * Cancel undoes only the keys THIS panel wrote.
	 *
	 * It used to restore the whole `own` object, so cancelling also reinstated
	 * any override removed elsewhere since the panel opened -- detaching the
	 * control from its preset and snapping it back to stale values.  With
	 * several windows on one document that stops being an edge case, so cancel
	 * has to be a targeted undo rather than a rollback of everything.
	 */
	const touched = new Set();
	const onChange = ( key ) => {
		if( key !== undefined ) touched.add( key );
		opts.onChange && opts.onChange();
	};

	const ctx = {
		canvas:  opts.canvas,
		sources: opts.sources || [],
		rebuild: () => { build(); },
		/* An args bag is described by whatever its sibling selector chose. */
		argsSchemaFor( key ) {
			if( key === "actionArgs" ) {
				const action = getAction( control.props.action );
				return action && action.args;
			}
			if( key === "sourceArgs" )
				return ( opts.sourceSchemas || {} )[ control.props.source ];
			return null;
		},
	};

	function build() {
		form.textContent = "";

		/*
		 * The preset picker lives on the general half, because which named style
		 * a button follows is part of how it looks, not what it does.  It binds
		 * control.preset, which is NOT a property -- it is the reference that
		 * makes the properties resolve.
		 */
		if( opts.generalOnly && opts.canvas ) {
			const names = opts.canvas.styleNames();
			if( names.length ) {
				const shim = { preset: control.preset || "" };
				buildSelect( form, shim, "preset", "Style preset",
					[ "" ].concat( names ),
					() => { control.preset = shim.preset || null; onChange(); build(); } );
				form.lastElementChild &&
					form.lastElementChild.classList.add( "tt-preset-row" );
			}
		}

		for( const [ name, spec ] of Object.entries( fields ) ) {
			buildField( form, control.props, name, spec, ctx, onChange );
			markOrigin( form.lastElementChild, control, name,
				() => { onChange( name ); build(); } );
		}
	}
	build();

	const buttons = document.createElement( "div" );
	buttons.className = "tt-prop-buttons";

	/*
	 * Recording happens HERE rather than on the Okay button, so every way out
	 * of the panel behaves: Okay, the caption's close button, or Escape.
	 *
	 * Cancel restores first and then closes, which needs no special case --
	 * record() drops an entry whose before and after match, so a cancelled
	 * panel leaves the stack untouched by arithmetic rather than by a flag.
	 */
	let settled = false;
	const close = () => {
		// hide() can raise "close", which lands back here; without the guard
		// the panel would record its entry twice.
		if( settled ) return;
		settled = true;
		openPanels.delete( key );
		if( history )
			history.record( "Edit " + control.type,
				[ { target: control, before: snapshot } ] );
		popup.hide();
	};
	popup.on( "close", close );

	const ok = document.createElement( "button" );
	ok.textContent = "Okay";
	ok.addEventListener( "click", close );

	const cancel = document.createElement( "button" );
	cancel.textContent = "Cancel";
	cancel.addEventListener( "click", () => {
		for( const name of touched ) {
			if( Object.prototype.hasOwnProperty.call( before, name ) )
				control.own[ name ] = before[ name ];
			else
				control.revert( name );   // no local value before; leave none
		}
		opts.onChange && opts.onChange();
		close();
	} );

	buttons.append( ok, cancel );
	popup.divContent.appendChild( buttons );

	/* Re-read every field from the model, for when something else edits this
	   control while the panel is open. */
	popup.sync = () => build();

	openPanels.set( key, popup );
	// hide() does not necessarily raise "close", so the buttons deregister too.
	popup.on( "close", () => openPanels.delete( key ) );

	popup.show();

	// Default placement is the top-left corner, which lands on the toolbar.
	// Put it beside the control instead, clamped into the viewport.
	if( opts.near ) {
		const frame = popup.divFrame;
		const w = frame.offsetWidth || 340, h = frame.offsetHeight || 300;
		frame.style.left = Math.max( 8,
			Math.min( opts.near.x + 24, window.innerWidth  - w - 8 ) ) + "px";
		frame.style.top = Math.max( 8,
			Math.min( opts.near.y,      window.innerHeight - h - 8 ) ) + "px";
	}

	return popup;
}

/**
 * Edit a style preset.
 *
 * The same field builder over the preset's own values instead of a control's.
 * Every control referencing it updates as you type, which is the entire point
 * of the presets being live -- so the caller gets told who to refresh.
 *
 * @param {object} canvas
 * @param {string} name
 * @param {{onChange:(controls:object[])=>void, near?:{x:number,y:number}}} opts
 */
export function editStyleProperties( canvas, name, opts ) {
	const style = canvas.styles[ name ];
	if( !style ) return null;

	const key = "style:" + name;
	const already = openPanels.get( key );
	if( already ) {
		if( typeof already.raise === "function" ) already.raise();
		return already;
	}

	const popup = popups.create( `Style — ${name}` );

	/*
	 * One undo entry per session. The whole `styles` map is the unit because a
	 * preset edit can add or drop governed keys, not just change values.
	 */
	const history = opts.history || null;
	const before = history ? history.captureCanvas( canvas, "styles" ) : null;
	let settled = false;
	const finish = () => {
		if( settled ) return;
		settled = true;
		openPanels.delete( key );
		if( history )
			history.record( `Edit style ${name}`,
				[ { kind: "canvas", target: canvas, key: "styles", before } ] );
	};

	const form = document.createElement( "div" );
	form.className = "tt-prop-form";
	popup.divContent.appendChild( form );

	const users = () => canvas.controlsUsingStyle( name );
	const onChange = () => opts.onChange && opts.onChange( users() );

	const ctx = { canvas, sources: opts.sources || [], rebuild: () => build(),
	              argsSchemaFor: () => null };

	function build() {
		form.textContent = "";

		const note = document.createElement( "div" );
		note.className = "tt-args-empty";
		const n = users().length;
		note.textContent = `governs ${style.keys.length} propert${style.keys.length === 1 ? "y" : "ies"}`
			+ ` — used by ${n} control${n === 1 ? "" : "s"}`;
		form.appendChild( note );

		for( const propKey of style.keys ) {
			const spec = COMMON[ propKey ] || { type: "string", label: propKey };
			buildField( form, style.values, propKey, spec, ctx, onChange );

			// Dropping a key here releases every control back to its own default.
			const rowEl = form.lastElementChild;
			const drop = document.createElement( "button" );
			drop.className = "tt-revert";
			drop.type = "button";
			drop.textContent = "✕";
			drop.title = `Stop governing ${propKey}`;
			drop.addEventListener( "click", ( e ) => {
				e.preventDefault();
				style.release( propKey );
				onChange();
				build();
			} );
			rowEl && rowEl.appendChild( drop );
		}
	}
	build();

	const buttons = document.createElement( "div" );
	buttons.className = "tt-prop-buttons";
	const done = document.createElement( "button" );
	done.textContent = "Done";
	done.addEventListener( "click", () => { finish(); popup.hide(); } );
	buttons.appendChild( done );
	popup.divContent.appendChild( buttons );

	popup.sync = () => build();
	openPanels.set( key, popup );
	// Both, because a non-modal hide() raises only "hide".
	popup.on( "hide", finish );
	popup.on( "close", finish );
	popup.show();

	if( opts.near ) {
		const frame = popup.divFrame;
		const w = frame.offsetWidth || 340, h = frame.offsetHeight || 300;
		frame.style.left = Math.max( 8, Math.min( opts.near.x + 24, window.innerWidth - w - 8 ) ) + "px";
		frame.style.top  = Math.max( 8, Math.min( opts.near.y, window.innerHeight - h - 8 ) ) + "px";
	}
	return popup;
}
