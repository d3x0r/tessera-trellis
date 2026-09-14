/**
 * @fileoverview sideplayr gameproxy: the security provider, and nothing else.
 *
 * Deliberately SERVER-ONLY. A client half would have to be handed the session's
 * permission list to approximate anything, and the whole point of filtering the
 * document on the server is that a browser is never told what it may do -- a
 * control it may not use simply never arrives. So there is nothing here for a
 * client half to be cheaper about, and shipping one would mean shipping the
 * permission list to do it.
 *
 * It is also PURE. Nothing in this file opens a database or knows sideplayr's
 * schema. The session arrives already resolved through the ticket backchannel:
 * gameproxy did the lookup, because gameproxy is the thing that owns
 * `positions`, `position_permissions` and `roleAllowsModulePermission`. This
 * service holds the answer, never the question.
 *
 * The session slice this reads:
 *
 *   session.gameproxy = {
 *       employeeId: 4299,
 *       role:       "Manager",           // positions.name
 *       room:       "Bingo",             // the room the station is bound to
 *       station:    "MAC:04:7c:...",
 *       permissions: [ "POS/Void Transaction", "Caller/login" ],
 *   }
 *
 * and the requirement a control carries:
 *
 *   control.security = { gameproxy: { module: "POS", permission: "Void Transaction" } };
 *   control.security = { gameproxy: { permissions: [ "Caller/login" ], role: [ "Manager", "Supervisor" ] } };
 */

import { registerSecurityProvider } from "../security.mjs";

/** `module` + `permission` is the pair sideplayr's own check takes. */
function pairOf( req ) {
	if( req.module && req.permission ) return req.module + "/" + req.permission;
	return null;
}

function asList( v ) {
	if( v === undefined || v === null ) return [];
	return Array.isArray( v ) ? v : [ v ];
}

registerSecurityProvider( "gameproxy", {
	label: "sideplayr",

	/*
	 * AND across the fields, because adding a condition must only ever
	 * restrict. `role` is a LIST that ORs, which is the documented place for an
	 * or -- inside the provider that understands its own vocabulary. "Manager
	 * or Supervisor" is a thing a hall means; "this permission or that role"
	 * across providers is not.
	 */
	test( req, session ) {
		if( !req || "object" !== typeof req ) return true;
		const mine = ( session && session.gameproxy ) || null;

		const need = asList( req.permissions );
		const pair = pairOf( req );
		if( pair ) need.push( pair );
		const roles = asList( req.role ).map( String );

		// nothing asked for is nothing to refuse - consistent with a null
		// requirement, and with every other provider
		if( !need.length && !roles.length && !req.room ) return true;

		// ...but anything asked for of a session that has not logged in is a no.
		// An anonymous session is not a session with no restrictions.
		if( !mine ) return false;

		const have = Array.isArray( mine.permissions ) ? mine.permissions : [];
		if( !need.every( p => have.includes( p ) ) ) return false;

		if( roles.length && !roles.includes( String( mine.role ) ) ) return false;

		// A room requirement is how a control is pinned to one hall room -- a
		// board for Bingo that must not appear on a station bound to Testing.
		if( req.room && String( req.room ) !== String( mine.room ) ) return false;

		return true;
	},

	/** What the designer shows beside a control that carries one. */
	describe( req ) {
		const parts = [];
		const pair = pairOf( req );
		if( pair ) parts.push( pair );
		for( const p of asList( req.permissions ) ) parts.push( p );
		const roles = asList( req.role );
		if( roles.length ) parts.push( "role " + roles.join( " or " ) );
		if( req.room ) parts.push( "room " + req.room );
		return parts.length ? parts.join( ", " ) : "(no requirement)";
	},
} );

console.log( "plugin: gameproxy (security provider 'gameproxy')" );
