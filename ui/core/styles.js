/**
 * @fileoverview Style presets — named, reusable sets of property values.
 *
 * The third instance of a pattern the original already had twice: font presets
 * (`font preset %m=%b`, used as `font name=%m`) and glare sets (`%m button
 * glare=%m`, used as `button is %m`) were both named, document-scoped things a
 * control referenced by name.  A style preset is the same shape over a wider
 * set of properties, and eventually those two should collapse into it.
 *
 * LIVE, not stamped.  A control keeps a reference; editing the preset changes
 * every control using it.  Copying the values in at apply time would be far
 * simpler, but then changing your mind about the danger red means visiting
 * every button, which is the whole reason to have presets.
 *
 * A preset declares WHICH properties it governs.  That is the part that makes
 * it usable: "Danger" owns the colours and the glare set, and must not touch
 * `text`, `nextPage` or `action`, or applying it erases what makes each button
 * itself.
 *
 * Names are paths (`casino/Danger`), so the picker is the same tree the
 * create-control menu uses.
 */

export class Style {
	/** Properties this preset governs. Anything not listed is left alone. */
	keys = [];
	/** The values, for the governed keys. */
	values = {};

	constructor( keys, values ) {
		if( keys ) this.keys = keys.slice();
		if( values ) this.values = Object.assign( {}, values );
	}

	governs( key ) { return this.keys.includes( key ); }

	/** The value for a governed key, or undefined. */
	get( key ) {
		return this.governs( key ) ? this.values[ key ] : undefined;
	}

	/** Stop governing a key, so controls fall back to their own default. */
	release( key ) {
		const i = this.keys.indexOf( key );
		if( i >= 0 ) this.keys.splice( i, 1 );
		delete this.values[ key ];
	}

	set( key, value ) {
		if( !this.governs( key ) ) this.keys.push( key );
		this.values[ key ] = value;
	}
}

/**
 * Build a preset from a control's current values.
 *
 * @param {object} resolvedProps  the control's effective values
 * @param {string[]} keys         which of them the preset should govern
 */
export function captureStyle( resolvedProps, keys ) {
	const values = {};
	for( const key of keys )
		if( key in resolvedProps ) values[ key ] = resolvedProps[ key ];
	return new Style( keys, values );
}

/**
 * The read/write view a control exposes as `.props`.
 *
 * Reads resolve  own -> preset -> schema default.
 * Writes always land on `own`, so assigning a value is what "override here"
 * means, and deleting a key reverts to whatever the preset or default says.
 *
 * A Proxy rather than a computed snapshot so control modules keep doing
 * `inst.props.color` and the property panel keeps doing `props.color = x`,
 * with no idea any of this is happening.
 *
 * @param {object} own       the control's local values (serialized)
 * @param {() => object} styleOf     resolves the control's preset, or null
 * @param {() => object} defaultsOf  the control type's schema defaults
 */
export function makePropsView( own, styleOf, defaultsOf ) {
	const resolve = ( key ) => {
		if( Object.prototype.hasOwnProperty.call( own, key ) ) return own[ key ];
		const style = styleOf();
		if( style ) {
			const v = style.get( key );
			if( v !== undefined ) return v;
		}
		const defaults = defaultsOf();
		return defaults ? defaults[ key ] : undefined;
	};

	const allKeys = () => {
		const keys = new Set( Object.keys( defaultsOf() || {} ) );
		const style = styleOf();
		if( style ) for( const k of style.keys ) keys.add( k );
		for( const k of Object.keys( own ) ) keys.add( k );
		return [ ...keys ];
	};

	return new Proxy( own, {
		get( _t, key ) {
			if( typeof key === "symbol" ) return undefined;
			return resolve( key );
		},
		set( _t, key, value ) { own[ key ] = value; return true; },
		/** Deleting an override is how you revert to the preset. */
		deleteProperty( _t, key ) { delete own[ key ]; return true; },
		has( _t, key ) { return allKeys().includes( key ); },
		ownKeys() { return allKeys(); },
		getOwnPropertyDescriptor( _t, key ) {
			return { value: resolve( key ), enumerable: true, configurable: true,
			         writable: true };
		},
	} );
}

/** Where a control's value for a key actually comes from. */
export function valueOrigin( own, style, key ) {
	if( Object.prototype.hasOwnProperty.call( own, key ) ) return "local";
	if( style && style.get( key ) !== undefined ) return "preset";
	return "default";
}
