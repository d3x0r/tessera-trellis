/**
 * @fileoverview Example plugin, server half.
 *
 * A plugin's server half registers actions and sources.  It is imported by the
 * server at startup and is NEVER served to a browser -- which is why it lives
 * here rather than under ui/.  Only the schemas its registrations declare ever
 * reach a client.
 *
 * This is the seam for wrapping an existing application: run() can call a REST
 * endpoint, a child process or a database just as easily as the array below.
 */

import { registerSource } from "../sources.mjs";
import { registerAction } from "../actions.mjs";

const players = [
	{ id: "P1001", name: "Ana Ruiz",     tier: "Gold",   visits: 41, flagged: false },
	{ id: "P1002", name: "Bo Fletcher",  tier: "Silver", visits:  8, flagged: false },
	{ id: "P1003", name: "Cy Nakamura",  tier: "Gold",   visits: 63, flagged: true  },
	{ id: "P1004", name: "Dee Okonkwo",  tier: "Bronze", visits:  2, flagged: false },
	{ id: "P1005", name: "Eli Andersen", tier: "Silver", visits: 19, flagged: false },
];

registerSource( "players", {
	label: "Player search",
	/* Fixed by the designer: which tier this particular control is scoped to. */
	args:  { tier: { type: "string", label: "Limit to tier" } },
	/* Typed by the user at run time, and filtered here, not in the browser. */
	input: { name: { type: "string", label: "Name contains" } },
	columns: [
		{ key: "id",      label: "ID" },
		{ key: "name",    label: "Name" },
		{ key: "tier",    label: "Tier" },
		{ key: "visits",  label: "Visits", align: "right" },
		{ key: "flagged", label: "Flag" },
	],
	run( { args, input } ) {
		const needle = ( input.name || "" ).toLowerCase();
		return players
			.filter( p => !args.tier || p.tier === args.tier )
			.filter( p => !needle || p.name.toLowerCase().includes( needle ) )
			.map( p => ( { ...p, flagged: p.flagged ? "yes" : "" } ) );
	},
} );

registerAction( "flagPlayer", {
	label: "Flag selected player",
	/* The row the user picked arrives as press-time input. */
	input: { id: { type: "string", label: "Player id" } },
	run( { input } ) {
		const player = players.find( p => p.id === input.id );
		if( !player ) throw new Error( "no such player" );
		player.flagged = !player.flagged;
		return {
			value: { id: player.id, flagged: player.flagged },
			broadcast: { op: "playerFlagged", id: player.id, flagged: player.flagged },
		};
	},
} );

console.log( "plugin: players (source 'players', action 'flagPlayer')" );
