/**
 * @fileoverview Winner verification.
 *
 * Shows itself while the proxy has the game in verify mode (the `verify`
 * message) and hides otherwise, so it can sit over the call screen in the
 * document without a page of its own.  Winners list on the left, the balls
 * as called in the middle, the picked winner's marked card on the right --
 * the card draws with /common/bingo/cardverify.js from the proxy, the same
 * renderer the floor verifier uses.
 *
 * Verify / Reject only mark the list here, as the caller page did; Done tells
 * the proxy (and so the floor and the boards) that verifying is over.
 */

import { registerControl } from "../../../core/registry.js";
import { PropType } from "../../../core/properties.js";
import { state, caller, modules, isDesigner } from "../lib/connection.js";
import { whenReady, listen, detach } from "../lib/bind.js";

const STATES = [ "viewed", "verified", "rejected" ];

function button( parent, cls, label, onClick ) {
	const b = document.createElement( "button" );
	b.type = "button";
	b.className = "ttc-verify-button " + cls;
	b.textContent = label;
	b.addEventListener( "click", onClick );
	parent.appendChild( b );
	return b;
}

registerControl( "caller/Verify", {
	description: "Winner verification; appears while the game is being validated.",
	properties: {
		alwaysShow: { type: PropType.Bool, label: "Show when idle (for layout)", default: false },
		security:   { type: PropType.Security, label: "Security" },
	},

	create( inst ) {
		const host = document.createElement( "div" );
		host.className = "ttc-verify";

		const list = document.createElement( "div" );
		list.className = "ttc-verify-list";
		const balls = document.createElement( "div" );
		balls.className = "ttc-verify-balls";
		const cardFrame = document.createElement( "div" );
		cardFrame.className = "ttc-verify-card";
		const actions = document.createElement( "div" );
		actions.className = "ttc-verify-actions";
		host.append( list, balls, cardFrame, actions );

		const rows = new Map();   // winner -> row element
		let selected = null;
		let cardView = null;

		const setState = ( winner, st ) => {
			const row = rows.get( winner );
			if( !row ) return;
			row.classList.remove( ...STATES );
			if( st ) row.classList.add( st );
		};
		const getState = ( winner ) => {
			const row = rows.get( winner );
			return row ? ( STATES.find( s => row.classList.contains( s ) ) || "" ) : "";
		};

		const select = ( winner ) => {
			if( !winner ) return;
			// stepping off a card that was only looked at marks it viewed
			if( selected && selected !== winner && !getState( selected ) ) setState( selected, "viewed" );
			for( const row of rows.values() ) row.classList.remove( "selected" );
			const row = rows.get( winner );
			if( row ) row.classList.add( "selected" );
			selected = winner;
			if( cardView && winner.card && winner.card.pack ) cardView.setVerify( winner.card );
			else if( !winner.card ) console.log( "caller: winner has no card to show", winner );
		};

		const addRow = ( winner ) => {
			if( !winner || rows.has( winner ) ) return;
			const row = document.createElement( "div" );
			row.className = "ttc-verify-row";
			const name = document.createElement( "div" );
			name.className = "ttc-verify-name";
			name.textContent = ( ( winner.FirstName || "" ) + " " + ( winner.LastName || "" ) ).trim() || "(no player)";
			const card = document.createElement( "div" );
			card.className = "ttc-verify-cardno";
			card.textContent = "Card " + ( winner.Sequenceno != null ? winner.Sequenceno : "?" );
			row.append( name, card );
			row.addEventListener( "click", () => select( winner ) );
			list.appendChild( row );
			rows.set( winner, row );
		};

		const showBalls = () => {
			balls.textContent = "";
			for( const ball of state.order ) {
				const cell = document.createElement( "span" );
				cell.className = "ttc-verify-ball";
				cell.textContent = String( ball );
				balls.appendChild( cell );
			}
		};

		const fill = () => {
			list.textContent = "";
			rows.clear();
			selected = null;
			for( const winner of state.winners ) addRow( winner );
			showBalls();
			if( state.winners.length ) select( state.winners[ 0 ] );
		};

		const show = () => {
			const active = !!state.verifying || !!inst.props.alwaysShow;
			host.hidden = !active;
			host.classList.toggle( "active", !!state.verifying );
			if( state.verifying ) fill();
		};
		host._ttcShow = show;

		button( actions, "accept", "Verify", () => { if( selected ) setState( selected, "verified" ); } );
		button( actions, "reject", "Reject", () => { if( selected ) setState( selected, "rejected" ); } );
		button( actions, "all", "Verify All", () => { for( const w of rows.keys() ) setState( w, "verified" ); } );
		button( actions, "done", "Done", () => { if( !isDesigner() ) caller.verifyGame( false ); host.hidden = !inst.props.alwaysShow; } );

		show();
		whenReady( host, async ( ctx, box ) => {
			if( modules.origin && !isDesigner() ) {
				try {
					const mod = await import( modules.origin + "/common/bingo/cardverify.js" );
					if( box.disposed ) return;
					mod.createVerifyPopup.showCardNumber = false;
					cardView = mod.createVerifyPopup( cardFrame );
					// the canvases draw at their own resolution and scale by CSS
					for( const c of cardView.canvases || [] ) { c.canvas.style.width = "100%"; c.canvas.style.height = "auto"; }
					if( state.game ) cardView.setGame( state.game );
				} catch( err ) { console.error( "caller: cardverify.js:", err ); }
			}
			show();
			listen( box, state, "verify", show );
			listen( box, state, "winner", ( winner ) => { addRow( winner ); if( !selected ) select( winner ); } );
			listen( box, state, "call", showBalls );
			listen( box, state, "uncall", showBalls );
			listen( box, state, "endGame", show );
			listen( box, state, "endSession", show );
			listen( box, state, "game", ( game ) => { if( cardView && game ) cardView.setGame( game ); } );
		} );
		return host;
	},

	update( host ) { host._ttcShow(); },
	dispose( host ) { detach( host ); },
} );
