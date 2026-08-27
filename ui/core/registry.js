/**
 * @fileoverview Control registry.
 *
 * The C original registered controls by name-mangling statics into the process
 * registry, so the linker was the registration mechanism.  Here it is an
 * explicit call made as an import side effect -- the direct equivalent of
 * PRELOAD(), with no wrapper machinery in between.
 *
 * "Interfaces" are optional methods on the definition object; a control
 * implements one by having the key.  Unknown keys are rejected at register
 * time so a typo surfaces immediately instead of silently never firing.
 */

/** Methods a control definition may supply. */
export const LIFECYCLE = {
	/** (inst) => HTMLElement -- build the control's element. Required. */
	create: 1,
	/** (el, inst) => void -- push current props onto the element. */
	update: 1,
	/** (el, inst) => void -- release timers/listeners; element is discarded. */
	dispose: 1,
	/** (el, inst) => void -- page became active. */
	onShow: 1,
	/** (el, inst) => void -- page became inactive. */
	onHide: 1,
	/** (el, inst) => void -- edit mode entered; pause animation, clocks, video. */
	onEditBegin: 1,
	/** (el, inst) => void -- edit mode left; resume. */
	onEditEnd: 1,
	/** (inst) => boolean -- false hides the control on this page show. */
	queryShow: 1,
};

const META = { properties: 1, description: 1 };

const registry = new Map();

/**
 * @param {string} name  Registered control name, as it appears in a document.
 * @param {object} def   Definition; see LIFECYCLE.
 */
export function registerControl( name, def ) {
	if( registry.has( name ) )
		throw new Error( `control '${name}' is already registered` );
	if( typeof def.create !== "function" )
		throw new Error( `control '${name}' has no create()` );
	for( const key of Object.keys( def ) )
		if( !( key in LIFECYCLE ) && !( key in META ) )
			throw new Error( `control '${name}': unknown definition key '${key}'` );
	registry.set( name, def );
}

export function getControlDef( name ) {
	return registry.get( name );
}

export function controlNames() {
	return [ ...registry.keys() ].sort();
}

/**
 * Split slash-separated names into a tree.
 *
 * Names are PATHS, as they were in the C registry -- pages.h spelled the page
 * changer "page/Page Changer".  Anything named this way gets a menu for free:
 * control types, and style presets, and whatever comes next.
 *
 * @param {string[]} names
 * @returns {{groups:Map<string,object>, items:{label:string,name:string}[]}}
 */
export function nameTree( names ) {
	const root = { groups: new Map(), items: [] };
	for( const name of names ) {
		const parts = name.split( "/" );
		let node = root;
		for( let i = 0; i < parts.length - 1; i++ ) {
			if( !node.groups.has( parts[ i ] ) )
				node.groups.set( parts[ i ], { groups: new Map(), items: [] } );
			node = node.groups.get( parts[ i ] );
		}
		node.items.push( { label: parts[ parts.length - 1 ], name } );
	}
	return root;
}

/** The registry drawn as a tree, for the create-control menu. */
export function controlTree() {
	return nameTree( controlNames() );
}
