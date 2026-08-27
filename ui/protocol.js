/**
 * @fileoverview Client protocol.
 *
 * Request/reply helpers return promises; the op log and its broadcasts will
 * arrive as events on top of this.
 */

import { Protocol as Protocol_ }
	from "/node_modules/sack.vfs/apps/http-ws/client-protocol.js";

const REQUEST_TIMEOUT = 8000;

class Protocol extends Protocol_ {
	#pending = new Map();
	#invokes = new Map();
	#invokeSerial = 0;

	/** Which document this connection is acting on; sent with every invoke. */
	document = null;

	constructor() {
		super( "tessera-trellis" );

		this.on( "document",    ( msg ) => this.#settle( "document:" + msg.name, msg ) );
		this.on( "saved",       ( msg ) => this.#settle( "saved:" + msg.name, msg ) );
		this.on( "documentList",( msg ) => this.#settle( "documentList", msg ) );
		this.on( "controlList", ( msg ) => this.#settle( "controlList", msg ) );
		this.on( "actionList",  ( msg ) => this.#settle( "actionList", msg ) );

		this.on( "queried", ( msg ) => {
			const settle = this.#invokes.get( msg.token );
			if( !settle ) return;
			this.#invokes.delete( msg.token );
			settle( msg );
		} );

		this.on( "sourceList", ( msg ) => this.#settle( "sourceList", msg ) );
		this.on( "pluginList", ( msg ) => this.#settle( "pluginList", msg ) );
		this.on( "allPluginList", ( msg ) => this.#settle( "allPluginList", msg ) );
		this.on( "pluginsSaved",  ( msg ) => this.#settle( "pluginsSaved", msg ) );
		this.on( "imageList",  ( msg ) => this.#settle( "imageList", msg ) );

		for( const op of [ "imageStored", "imageRemoved" ] )
			this.on( op, ( msg ) => {
				const settle = this.#invokes.get( msg.token );
				if( !settle ) return;
				this.#invokes.delete( msg.token );
				settle( msg );
			} );

		this.on( "invoked", ( msg ) => {
			const settle = this.#invokes.get( msg.token );
			if( !settle ) return;
			this.#invokes.delete( msg.token );
			settle( msg );
		} );
	}

	#awaitToken( token, ms = REQUEST_TIMEOUT ) {
		return new Promise( ( resolve ) => {
			const timer = setTimeout( () => {
				this.#invokes.delete( token );
				resolve( { ok: false, error: "timed out" } );
			}, ms );
			this.#invokes.set( token, ( msg ) => { clearTimeout( timer ); resolve( msg ); } );
		} );
	}

	#settle( key, msg ) {
		const resolve = this.#pending.get( key );
		if( !resolve ) return;
		this.#pending.delete( key );
		resolve( msg );
	}

	/*
	 * Every request settles, one way or another.  A promise that waits forever
	 * is not a hang somewhere harmless -- these are awaited at module top level,
	 * so a dropped reply would stop the entry point from ever finishing.
	 */
	#expect( key, ms = REQUEST_TIMEOUT ) {
		return new Promise( ( resolve, reject ) => {
			const timer = setTimeout( () => {
				this.#pending.delete( key );
				reject( new Error( `timed out waiting for ${key}` ) );
			}, ms );
			this.#pending.set( key, ( msg ) => { clearTimeout( timer ); resolve( msg ); } );
		} );
	}

	/** Resolve once the socket is actually open, or false. */
	async whenReady( ms = 3000 ) {
		const until = Date.now() + ms;
		while( !this.ready && Date.now() < until )
			await new Promise( r => setTimeout( r, 50 ) );
		return this.ready;
	}

	/**
	 * @param {string} name
	 * @param {boolean} [editing]  ask for the document UNFILTERED. The designer
	 *        needs it -- you cannot edit what you cannot see -- and the request
	 *        is itself privileged, which is where an editing permission attaches.
	 */
	loadDocument( name, editing ) {
		const wait = this.#expect( "document:" + name );
		this.send( { op: "loadDocument", name, editing: !!editing } );
		return wait;
	}

	saveDocument( name, snapshot ) {
		const wait = this.#expect( "saved:" + name );
		this.send( { op: "saveDocument", name, snapshot } );
		return wait;
	}

	listDocuments() {
		const wait = this.#expect( "documentList" );
		this.send( { op: "listDocuments" } );
		return wait;
	}

	listControls() {
		const wait = this.#expect( "controlList" );
		this.send( { op: "listControls" } );
		return wait;
	}

	listImages() {
		const wait = this.#expect( "imageList" );
		this.send( { op: "listImages" } );
		return wait;
	}

	/**
	 * Upload an image over the socket.
	 * @param {string} name
	 * @param {Uint8Array} data  JSOX encodes the typed array directly
	 */
	putImage( name, data ) {
		const token = "u" + ( ++this.#invokeSerial );
		const wait = this.#awaitToken( token, 30000 );   // uploads can be slow
		this.send( { op: "putImage", token, name, data } );
		return wait;
	}

	removeImage( url ) {
		const token = "r" + ( ++this.#invokeSerial );
		const wait = this.#awaitToken( token );
		this.send( { op: "removeImage", token, url } );
		return wait;
	}

	listPlugins() {
		const wait = this.#expect( "pluginList" );
		this.send( { op: "listPlugins" } );
		return wait;
	}

	/** Every plugin on disk, with its halves and whether it is enabled. */
	listAllPlugins() {
		const wait = this.#expect( "allPluginList" );
		this.send( { op: "listAllPlugins" } );
		return wait;
	}

	/** Enable exactly these; written to config.jsox, applied on restart. */
	setPlugins( names ) {
		const wait = this.#expect( "pluginsSaved" );
		this.send( { op: "setPlugins", plugins: names } );
		return wait;
	}

	listSources() {
		const wait = this.#expect( "sourceList" );
		this.send( { op: "listSources" } );
		return wait;
	}

	/** Ask for a data control's rows. Same rule: name the control, not the query. */
	query( controlId, input ) {
		const token = "q" + ( ++this.#invokeSerial );
		const wait = this.#awaitToken( token );
		this.send( { op: "query", token,
		             document: this.document, control: controlId, input: input || {} } );
		return wait;
	}

	listActions() {
		const wait = this.#expect( "actionList" );
		this.send( { op: "listActions" } );
		return wait;
	}

	/**
	 * Tell the server which control was pressed.
	 *
	 * Deliberately no action name and no design-time arguments: the server
	 * reads those from its own copy of the document.  All this may carry is the
	 * control id and whatever the user supplied at press time.
	 */
	invoke( controlId, input ) {
		const token = "i" + ( ++this.#invokeSerial );
		const wait = this.#awaitToken( token );
		this.send( { op: "invoke", token,
		             document: this.document, control: controlId, input: input || {} } );
		return wait;
	}
}

export const protocol = new Protocol();
