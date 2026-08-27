/**
 * @fileoverview Property type vocabulary, and the common button property set.
 *
 * A property schema replaces three things the C version wrote by hand for
 * every control: the configuration dialog, the save serializer, and the
 * matching AddConfigurationMethod() reload callbacks.
 *
 * Types extend popups2's ValueOfType rather than competing with it; the form
 * builder maps each to an existing popups2 control.
 */

/** @enum {string} */
export const PropType = {
	String:   "string",
	Number:   "number",
	Bool:     "bool",
	Color:    "color",
	Image:    "image",
	Choice:   "choice",
	Font:     "font",
	/** Picker enumerates the pages of the owning canvas. */
	Page:     "page",
	/** Token set; edited by whichever security provider is installed. */
	Security: "security",
	/** Picker enumerates client actions plus whatever the server offers. */
	Action:   "action",
	/** Sub-form generated from the chosen action's args schema. */
	Args:     "args",
};

/**
 * Properties every button-like control carries.  'nextPage' living here is
 * what makes a dedicated page-changer control unnecessary -- in the original,
 * Page/Page Changer was "a common button with next page set".
 */
export const commonButtonProperties = {
	text:      { type: PropType.String, label: "Text", default: "",
	             hint: "'_' breaks a line" },
	color:     { type: PropType.Color,  label: "Background",  default: "#39394a" },
	secondary: { type: PropType.Color,  label: "Secondary",   default: "#22222c" },
	textColor: { type: PropType.Color,  label: "Text color",  default: "#f0f0f0" },
	image:     { type: PropType.Image,  label: "Image",       default: "" },
	font:      { type: PropType.Font,   label: "Font preset", default: "",
	             from: "fonts" },
	style:     { type: PropType.Choice, label: "Button is",
	             default: "bicolor square", from: "glareSets" },
	nextPage:  { type: PropType.Page,   label: "Next page",   default: "" },
	/*
	 * What the button does.  A named action rather than a bespoke control type,
	 * so a designer can wire behaviour without anyone writing a module.  Where
	 * it runs is the action's decision, not the button's.
	 *
	 * group:"specific" because the Edit / Edit General split is about behaviour
	 * versus appearance, not about which properties happen to be shared.  These
	 * are common to every button AND are the specific thing you open a button to
	 * change, so membership in this set cannot be what decides.
	 */
	action:     { type: PropType.Action, label: "Action", default: "none",
	              group: "specific" },
	actionArgs: { type: PropType.Args,   label: "Action settings", default: null,
	              group: "specific" },
	security:  { type: PropType.Security, label: "Security" },
};

/** Build a props object from a schema's defaults. */
export function defaultProps( schema ) {
	const out = {};
	if( !schema ) return out;
	for( const [ name, spec ] of Object.entries( schema ) )
		if( "default" in spec ) out[ name ] = spec.default;
	return out;
}
