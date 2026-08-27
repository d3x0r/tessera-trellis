/**
 * @fileoverview The client half of an application.
 *
 * An application supplies the things a *document* only refers to: variables,
 * client actions, and any control modules of its own.  It registers them as an
 * import side effect, exactly like a control module.
 *
 * This is separate from demo-canvas.js on purpose.  That file builds a seed
 * document and runs once, ever; this file must run on every load, because a
 * document fetched from storage still says "%Clock" and something has to know
 * what Clock is.  Folding the two together is what broke substitution the
 * moment documents started coming from the server.
 */

import { defineVariable, invalidateVariable } from "../core/variables.js";

defineVariable( "Host Mode Select", "Standalone" );
defineVariable( "Hall", "(unknown)" );

// A PROC-type variable: re-evaluated on invalidate, as LabelVariableChanged did.
defineVariable( "Clock", () => new Date().toLocaleTimeString() );
setInterval( () => invalidateVariable( "Clock" ), 1000 );
