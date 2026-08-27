/**
 * @fileoverview Text label.
 *
 * Text runs through the variable expander, so 'label=%Host Mode Select' works
 * the way it did in the original -- and re-renders when the variable changes.
 */

import { registerControl } from "../core/registry.js";
import { PropType } from "../core/properties.js";
import { expand, watch } from "../core/variables.js";

registerControl( "Text Label", {
	description: "Static or variable-driven text.",
	properties: {
		text:      { type: PropType.String, label: "Text", default: "Label",
		             hint: "%VariableName substitutes" },
		textColor: { type: PropType.Color,  label: "Color", default: "#f0f0f0" },
		font:      { type: PropType.Font,   label: "Font preset", default: "" },
		align:     { type: PropType.Choice, label: "Align", default: "center",
		             choices: [ "left", "center", "right" ] },
		valign:    { type: PropType.Choice, label: "Vertical", default: "center",
		             choices: [ "start", "center", "end" ] },
		shadow:    { type: PropType.Bool,   label: "Shadow", default: false },
		security:  { type: PropType.Security, label: "Security" },
	},

	create() {
		const el = document.createElement( "div" );
		el.className = "tt-label";
		return el;
	},

	update( el, inst ) {
		const p = inst.props;
		const render = () => { el.textContent = expand( p.text ); };
		el.style.color = p.textColor;
		el.style.textAlign = p.align;
		el.style.alignItems = p.valign;
		el.style.justifyContent = p.align === "left" ? "start"
			: p.align === "right" ? "end" : "center";
		el.style.textShadow = p.shadow ? "0 2px 4px rgba(0,0,0,.7)" : "";
		const canvas = inst.page && inst.page.canvas;
		const font = ( canvas && canvas.fontFor( p.font ) ) || p.font;
		if( font ) el.style.font = font;

		if( el._ttUnwatch ) el._ttUnwatch();
		render();
		el._ttUnwatch = watch( p.text, render );
	},

	dispose( el ) {
		if( el._ttUnwatch ) el._ttUnwatch();
	},
} );
