/**
 * @fileoverview Field -- a labelled input that publishes a press-time value.
 *
 * The producing half of the input model (see core/inputs.js).  A Field has a
 * NAME, and whatever is typed into it is published under that name; any button
 * on the document then carries it as press-time input, and the server keeps it
 * only if the action declares that key.  Nothing wires a field to a button:
 * the name is the wiring.
 *
 * A field publishes its value as soon as it is shown, not only on edit, so a
 * default the author set is what a press sees even when nobody touched it.
 */

import { registerControl } from "../core/registry.js";
import { PropType } from "../core/properties.js";
import { setInput, clearInput } from "../core/inputs.js";

const KINDS = [ "text", "number", "date", "time", "datetime-local", "password" ];

registerControl( "data/Field", {
	description: "Labelled input; its value is press-time input under 'name'.",
	properties: {
		name:        { type: PropType.String, label: "Input name", default: "",
		               hint: "the key an action's input schema declares" },
		label:       { type: PropType.String, label: "Label", default: "" },
		kind:        { type: PropType.Choice, label: "Kind", default: "text", choices: KINDS },
		value:       { type: PropType.String, label: "Default value", default: "",
		               hint: "'today' or 'now' for date/time kinds" },
		placeholder: { type: PropType.String, label: "Placeholder", default: "" },
		textColor:   { type: PropType.Color,  label: "Text colour", default: "#e8ecff" },
		security:    { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const el = document.createElement( "label" );
		el.className = "tt-field";

		const caption = document.createElement( "span" );
		caption.className = "tt-field-label";

		const box = document.createElement( "input" );
		box.className = "tt-field-box";

		el.append( caption, box );

		box.addEventListener( "input", () => publish( box, inst ) );
		box.addEventListener( "change", () => publish( box, inst ) );
		return el;
	},

	update( el, inst ) {
		const p = inst.props;
		const caption = el.querySelector( ".tt-field-label" );
		const box = el.querySelector( ".tt-field-box" );
		caption.textContent = p.label || "";
		caption.hidden = !p.label;
		box.type = KINDS.includes( p.kind ) ? p.kind : "text";
		box.placeholder = p.placeholder || "";
		box.style.color = p.textColor || "";
		// Only seed the value when the user has not typed over it.
		if( !box._ttTouched ) box.value = defaultFor( p );
		publish( box, inst );
	},

	onShow( el, inst ) {
		publish( el.querySelector( ".tt-field-box" ), inst );
	},

	dispose( el, inst ) {
		if( inst.props.name ) clearInput( inst.props.name );
	},
} );

function publish( box, inst ) {
	if( document.activeElement === box ) box._ttTouched = true;
	if( inst.props.name ) setInput( inst.props.name, box.value );
}

function two( n ) { return String( n ).padStart( 2, "0" ); }

/** 'today' / 'now' resolve at show time so a saved document is never stale. */
function defaultFor( p ) {
	const v = p.value || "";
	const d = new Date();
	if( v === "today" ) return `${d.getFullYear()}-${two( d.getMonth() + 1 )}-${two( d.getDate() )}`;
	if( v === "now" ) {
		if( p.kind === "time" ) return `${two( d.getHours() )}:${two( d.getMinutes() )}`;
		if( p.kind === "datetime-local" )
			return `${d.getFullYear()}-${two( d.getMonth() + 1 )}-${two( d.getDate() )}T${two( d.getHours() )}:${two( d.getMinutes() )}`;
	}
	return v;
}
