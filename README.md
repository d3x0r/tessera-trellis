# Tessera Trellis

A gridded page-layout runtime and designer — the web successor to InterShell
(formerly MILK, *Modular Interface Layout Kit*).

A *tessera* is the single tile of a mosaic; the trellis is the lattice it sits on.

```
npm start                     # http://localhost:8099
```

| URL | what it is |
|---|---|
| `/` | **runtime** — renders a document, nothing else |
| `/editor.html` | **designer** — imports the renderer, adds the overlay |

The editor is a separate URL rather than a keystroke inside the runtime, so the
editing machinery is never served to a runtime page and authentication has a
natural place to sit.

## The grid

A page is a fixed **10000 × 10000** lattice. One unit is 1/100th of a percent,
so a control's rect becomes CSS with no layout query and no track count:

```css
.tt-control {
	left:   calc( var(--x) * 0.01% );
	width:  calc( var(--w) * 0.01% );
}
```

CSS Grid is *not* used: `repeat(10000, 1fr)` is past the browser's practical
track limit. Percentage positioning is exact, and the browser still redoes the
math on every resize for free.

### Fine units are storage; grid units are display

The coarse grid (`canvas.grid.divisorX/Y`) is a **snap ruler**, not a coordinate
system. This is the one real departure from the original, where `page layout
%i by %i` *was* the storage resolution.

The reason: if controls were stored in grid units, changing a page from a
90-wide to a 24-wide grid would silently move every control (`x=12` goes from
13.3% to 50%), making the divisor a destructive setting. Storing fine units
means changing the ruler moves nothing — only future drags land differently.

Readability is recovered by converting at the edges. `toGridUnits()` /
`fromGridUnits()` in `core/coords.js` let the property panel show and accept
column numbers, so a human still reads `column 6.0` while the file holds `2500`.

Worst-case snap error across divisors 3–90 is 0.44 units — 0.0044% of the page,
sub-pixel at any real resolution, because snapping rounds from the true
fractional position rather than accumulating. (If exact tiling ever matters,
10080 divides by every common column count including 90 and 24.)

### Snap never runs behind your back

`snap()` is called only from a drag. Load and save are pure passthrough, so a
control at a free-placed 3450 stays at 3450 across any number of round trips.

A click is a zero-distance drag, so a **3px threshold** guards it — selecting a
free-placed control and twitching the mouse cannot snap it. Plain arrow keys
nudge in fine units (preserving an off-grid position); shift+arrow moves a whole
cell. The Snap toggle and Alt both disable snapping for free placement.

## Registering a control

Registration is an import side effect — the direct equivalent of `PRELOAD()`,
with no wrapper machinery:

```js
import { registerControl } from "../core/registry.js";

registerControl( "Clock", {
	properties: { analog: { type: "bool", label: "Analog", default: false } },
	create( inst ) { … },       // returns an HTMLElement
	update( el, inst ) { … },   // push props onto it
} );
```

"Interfaces" are optional methods (`onShow`, `onEditBegin`, `queryShow`, …);
a control implements one by having the key. Unknown keys throw at register
time, so a typo surfaces instead of silently never firing.

The `properties` declaration replaces three hand-written things per control:
the configuration dialog, the save serializer, and the matching
`AddConfigurationMethod()` reload callbacks. `clock_addon.c` spent roughly 160
of its 351 lines on exactly that.

`nextPage` is a *common button property*, which is why no page-changer control
exists — in the original, `Page/Page Changer` was "a common button with next
page set".

## No ambient current-page state

Nothing reads a global. A control reaches its page via `inst.page` and its
canvas via `inst.page.canvas`; navigation is a `tt-navigate` event that bubbles
to the page element, so no control holds a view reference.

This is deliberate. `InterShell_GetCurrentLoadingCanvas()`,
`InterShell_GetCurrentButton()` and `ShellGetCurrentPage()` are what made the
multi-window branch expensive — each had to become a threaded `PPAGE`, with no
payoff until the last one landed. Multi-window here means several views over a
server-held document, so there is no ambient "current" anything to thread.
**Do not add one.**

## Layers: the shared bar

A canvas has a `shared` page whose controls render on **every** page — the
header/footer bar, a watermark, a persistent status light. It is deliberately
just another `Page`, so it serializes, hit-tests, snaps and secures through
exactly the same code.

```js
canvas.setBands( 1111, 1111 );                    // header, footer (fine units)
canvas.shared.add( new Control( "Text Label", … ) );
```

Structurally this is the app-shell pattern: shared layer = the shell, `body`
inset = where the outlet sits.

**What was rejected:** modelling header / body / footer as separate regions each
with their own grid. That reintroduces "which space is this coordinate in?",
which is the exact ambiguity that made the C version expensive to untangle. A
shared control at `y:500` means the same thing as a page control at `y:500`.

### The inset is a guide, not a wall

`canvas.body` has insets on all four sides — a left rail works like a header.
It seeds where new page controls land and the editor shades it, but it does
**not** confine anything: the free space in a control bar is a perfectly good
place for a page control. Drags are bounded by the page and nothing narrower.

(An earlier cut did clamp page controls out of the bands. It was wrong for
exactly that reason.)

### Page background video

`background.video` plus `background.videoLoop`, edited in Page properties. It
plays over the background colour and under every control.

- `muted` is not a preference — browsers block audible autoplay outright, so an
  unmuted background video would simply never start. `playsinline` stops iOS
  taking it fullscreen.
- `pointer-events: none`, because a `<video>` swallows clicks exactly the way an
  iframe does and the overlay owns input.
- Inserted as the **first child** of the page element, so DOM order puts it
  behind every control without a z-index.
- **Paused while editing**, same reasoning as the Web Page scrim: a moving
  background is a poor thing to arrange a layout against, and a still frame is
  what you need to judge contrast against.
- `src` is assigned only when it changes; reassigning restarts playback.

A plain URL rather than the image picker, since that picker uploads to the
image store and a video is a different asset with different limits.

### Layer isolation

The editor acts on one layer at a time (`overlay.layer`). Only the active
layer hit-tests, so a header bar cannot be grabbed while arranging a page, and
page controls cannot be grabbed while arranging the bar.

## Serialization

JSOX, via registered types. `"Control"{…}` typed notation *is*
`control generic <name>`: registered name → constructed instance, the same
mechanic, already implemented, with cycles and shared references surviving.
Back-references are private fields, so they stay off the wire; `Canvas.relink()`
restores them after a parse.

The burst config parser is not retired — it becomes the `.isp` importer, which
is how existing layouts come forward as realistic test documents.

## Actions: what a button does

The C original fused behaviour to control *type* — `OnCreateMenuButton("Quit POS")`
was a whole module. Right for a Clock, whose behaviour *is* its type; wrong for
fifty buttons, which would need fifty modules and defeat the point of a
designer. So `action` is a **common button property**, chosen from a menu.

### The client says which control, never what to do

A press sends exactly this and nothing more:

```js
{ op:"invoke", token:"i1", document:"Demo Station", control:"wxsv15x3", input:{} }
```

The server resolves `wxsv15x3` against **its own copy of the document**, reads
the action name and its design-time arguments from *there*, checks security on
that control, and only then runs it. So a client cannot invoke an action no
control was wired to, cannot substitute its own arguments, and cannot invoke a
control its session may not see.

Press-time input (a typed field, a selected row) does cross the wire — it has
to — and is validated against the action's `input` schema. That is data, never
authority.

This is why both the runtime and the editor **load the document from the
server**. A locally invented document would carry ids the server has never
heard of; the same property, seen from the other side, is what makes the scheme
work at all.

### Where an action runs is a security decision

The test is *"if the client lied about this, would it matter?"*

| where | examples | why |
|---|---|---|
| `client` | page change, display variable, focus | a round trip to change a page is absurd latency, and nothing is at stake |
| `server` | enable participant, launch a task, anything durable | the client's security check is decoration; only the server's enforces |

Client actions register in `ui/core/actions.js` and run locally. Server actions
register in `server/actions.mjs`; only their *schemas* travel, so the designer
can offer them without the behaviour ever reaching a browser. An action that
changes shared state returns a `broadcast`, so every open window updates rather
than only the presser.

`nextPage` stays a first-class property rather than becoming an action, because
page changing is the one behaviour common enough to deserve its own slot — it
is why the original needed no page-changer control.

## Data controls: the mirror of a button

A button sends; a table, receipt list or search result receives. Same
resolution, opposite direction — the client names a **control**, and the server
reads the source, its design-time arguments and its columns from the document:

```js
{ op:"query", token:"q2", document:"Demo Station", control:"9g8omdb2", input:{ clerk:"an" } }
```

The control does not know what a receipt is. `data/Table` renders whatever
columns the source declares, so a new report is a `registerSource()` call, not
a new control module. Runtime filters (a search box) go in `input` and are
applied server-side. Selecting a row raises `tt-row`, which is how a row
becomes press-time input for a button that acts on it.

Same caveat as actions: the session is the gate. Binding arguments to the
control means a receipt list scoped to one till cannot be re-pointed at another
by a client editing its own query — useful, but not the wall.

## Writing a plugin

A plugin has two halves in two directories, because a plugin's server code must
not be fetchable over HTTP just because its client code has to be:

```
server/plugins/…       actions + sources; imported at startup,
                       NEVER served to a browser
ui/plugins/…           controls, client actions, variables;
                       listed to clients, imported before render
```

### Two layouts, the same on both halves

```
plugins/<name>.mjs         a loader file, optionally beside a
plugins/<name>/              same-named directory of support classes

plugins/<name>/index.mjs   everything under one directory
```

Either works, on either half, and a loader file **wins** over a directory
index — so `<name>.mjs` beside `<name>/` loads the file and treats the
directory purely as support code. That is the case worth having once a plugin
outgrows one file: a login provider is a server-side check, a client-side
approximation, a session shape and a login UI, which is more than an
`index.js` wants to hold.

The two halves used to disagree — server was a file, client was a
directory-with-`index.js` — so a plugin's two halves were laid out differently
for no reason an author could have guessed. Both forms are accepted rather than
one being migrated to, so nothing has to move and the Plugins panel keeps
reporting which halves exist instead of a renamed plugin quietly reading as
one-sided.

### Discovery reads a Volume, not the filesystem

`sack.Volume()` rather than `node:fs`. Same answers for a plain directory, and
it also reads a **container** — so a packaged or encrypted deployment can ship
its plugins inside one without this code changing. `dir()` reports `folder`
directly, which is the one thing the layout rules need, and it accepts absolute
paths in either slash style.

Both halves are plain modules that call the same registration functions the
built-ins use — there is no plugin API to learn beyond those:

```js
// server/plugins/players.mjs
import { registerSource } from "../sources.mjs";
import { registerAction } from "../actions.mjs";

registerSource( "players", {
	args:    { tier: { type:"string", label:"Limit to tier" } },   // designer sets
	input:   { name: { type:"string", label:"Name contains" } },   // user types
	columns: [ { key:"id", label:"ID" }, { key:"name", label:"Name" } ],
	run( { args, input } ) { /* REST call, child process, SQL, anything */ },
} );
```

```js
// ui/plugins/players/index.js
import { registerControl } from "../../core/registry.js";

export function useProtocol( mod ) { /* optional; the loader calls it */ }
registerControl( "data/Player Search", { properties: {…}, create( inst ) {…} } );
```

Drop the files in, restart. The server imports the enabled `server/plugins/*.mjs`
before it opens the port, and both entry points import every client half the
server offers **before anything renders** — a document may name a control type
that only a plugin registers, and an unregistered type renders as nothing.

### Choosing which plugins load

`config.jsox` at the service root (`TT_CONFIG` overrides the path). The file is
optional; without it nothing changes.

```jsox
{
	port: 8099,               // PORT in the environment still wins
	plugins: [ "players" ],   // or "*" for every one found on disk
}
```

`"*"` — or no config file at all — scans both plugin directories, which is what
the service did before there was a config. An array selects explicitly, and its
**order is preserved**, because registration order is observable: a later plugin
can take an action or source name an earlier one registered.

A plugin may be one-sided — server-only (an action provider with no UI of its
own) or client-only (controls needing no server). A configured name matching
neither half is reported at startup rather than silently skipped.

The selection gates both halves from one list: `listPlugins` only advertises the
client halves of enabled plugins, so disabling a plugin stops its browser code
being served, not just its server code being imported.

### The Plugins panel

The designer's **Plugins** button lists every plugin found on disk with a
checkbox, and shows which halves each one has (`server + client`, or just one —
a one-sided plugin is legal, and seeing which is which explains why enabling
one changes the create menu while another only adds actions).

Saving rewrites `plugins` in config.jsox and **takes effect on restart**. That
is not a shortcut: a server half is imported once at startup and an ES module
cannot be un-imported, so a panel claiming to apply immediately would be lying
about the half that matters. The panel says so instead.

Which plugins load is a property of the **deployment**, not of a document, so
this is a service setting and never serializes with a canvas. Two documents on
one server see the same set.

Three things worth keeping:

- **The write is surgical, not a re-serialize.** It replaces only the
  `plugins: [...]` array by pattern, because config.jsox is hand-editable and
  carries comments explaining the options — `JSOX.stringify` of the whole
  object would silently discard them. Verified: after a UI save, every comment
  is still there.
- **Every reply op must be registered in `ui/protocol.js`'s constructor.**
  Adding `listAllPlugins()` without a matching
  `this.on( "allPluginList", … => this.#settle( … ) )` leaves the promise
  pending until the 8s timeout — the panel simply never appears, with the
  server answering correctly the whole time.
- **`hide()` then `remove()`**, and clear the open-panel reference on every
  exit path. `hide()` only sets `display:none` and does not reliably raise
  `close`; without both, the toolbar button eventually raises a hidden popup
  instead of building a new one, and every open leaves another dead frame in
  the document.

**Construction order matters here.** `new Protocol()` binds the listener, so it
cannot happen at module scope — an import that opens the port beats
`await loadServerPlugins()` to it, and a client connecting in that window gets
empty action and source lists. Hence `start()`: load, *then* listen. (This was
a real bug; the port used to open on import.)

Because control names are paths, `"data/Player Search"` appears in the
right-click tree under `data` with no menu code to change, and the source and
action appear in the designer's pickers because their schemas travel.

This is the seam for wrapping an existing application: `run()` can call
whatever the real system exposes. For sideplayr that means its launcher and log
REST endpoints become a source and a few actions, and the shell does not change.

### Worked example: the Web Page plugin

`ui/plugins/iframe/` — a **client-only** plugin (no server half), which is why
enabling it says *reload*, not *restart*. It registers `web/Web Page`, and
because names are paths it appears under `web` in the create tree with no menu
code changed anywhere.

It is also the control the edit overlay exists for. An iframe captures every
pointer event inside its own document, so a designer that listened on each
control's DOM node could never drag one — you would grab the framed page
instead. Because the overlay owns input while editing, this drags exactly like
a button, with nothing special in the plugin.

Four things that are easy to get wrong here:

- **Assign `src` only when it changed.** Setting `.src` reloads the frame even
  to an identical value, so an unconditional assignment in `update()` reloads
  the page on every unrelated property edit — nudge the control and the
  dashboard inside it refetches.
- **`sandbox` is subtractive.** Present means "deny all but these"; absent
  means no restriction. The `trusted` preset therefore *omits* the attribute
  rather than listing every token — `allow-scripts` with `allow-same-origin`
  lets a same-origin document remove its own sandbox, and a preset that looked
  restrictive while being nothing of the sort is worse than an honest "none".
- **Cover the frame while editing.** `onEditBegin` stops the refresh timer and
  shows a scrim with the resolved URL — a live page is a poor thing to arrange
  a layout against, it may animate or play audio, and many sites refuse to be
  framed at all (`X-Frame-Options`), so the URL is the useful thing to see at
  design time.
- **The URL runs through `expand()`**, so `%Host Mode Select` substitutes and
  the frame re-points when the variable changes — the same binding labels use.

#### URLs

`normalizeUrl()` in `plugins/iframe/url.js`, applied at render — the stored
property keeps exactly what was typed, so the same document served over https
resolves to https.

**`localhost:8085/x` is not parsed as host:port.** Scheme grammar allows
letters, digits, `+`, `-` and `.`, so a browser reads `localhost:` as the
SCHEME and the rest as the path. That is a custom protocol, which a sandboxed
frame refuses with *"Navigation to external protocol blocked by sandbox"* — an
error naming the sandbox while the actual fault is three missing characters.
Widening the sandbox hides it; normalising fixes it.

A missing scheme inherits **`location.protocol`**, not a hardcoded `https:`.
An https page cannot frame an http one at all (mixed content), so inheriting
the page's own protocol is the only default that cannot produce a frame
guaranteed to fail.

A site-relative path must be written `./page.html` or `/page.html`; a bare
`page.html` is treated as a host, because for this control a bare string is
overwhelmingly a website and guessing by sniffing file extensions would be
wrong less obviously.

#### allow-same-origin, and when the sandbox is theatre

Without `allow-same-origin` the framed document gets an *opaque* origin, so
`localStorage` throws `SecurityError`. The **Allow storage** toggle grants it,
spelled by symptom rather than by token.

It is a toggle rather than a preset because the grant is only sometimes safe:
`allow-scripts` + `allow-same-origin` on a document **same-origin with the
embedder** lets that page reach `parent.document`, remove its own `sandbox`
attribute and reload unsandboxed — the sandbox restrains nothing. Origin
includes the **port**, so a designer on `:8099` framing an app on `:8085` is
cross-origin and there is no such path. The scrim says so when the combination
is moot, rather than letting it read as protection that is not there.

**Two popups2 bugs surfaced here and are fixed upstream** (`controls/checkbox.js`):
`Checkbox` never read `opts.change` — only `.on("change", cb)` populated its
listeners — while `ChoiceInput` always honoured it, which is why selects and
colours updated live and checkboxes never did. And its input-level `change`
handler called `setValue()` without firing those listeners, so clicking the
**box** stored the value and told nobody; only clicking the *label* notified.
The visible symptom was a tick that updated the model, left the preview stale,
and never entered the panel's `touched` set — so Cancel would not restore it
and undo never saw it. Checked against the pre-split `popups.mjs`: both
behaviours are original, so this was long-standing rather than a split
regression.

**Writing it found a real framework bug**, now fixed in `render/canvas-view.js`:
a control created while edit mode was *already on* never received
`onEditBegin`, because that hook only fired for views existing when
`setEditing(true)` ran. Placing a clock, a video or this would leave it
running under the designer. `#buildView` now applies the current editing state
to a newly built control.

### Control ids

`SaltyRNG.Id()` from `@d3x0r/srg2` — the house short id: 12 bytes as 16 base64
characters, with the current second in the leading bytes. It resolves bare in
node and through the importmap in the browser, so both sides mint ids
identically (`sack.Id()` is the same thing native, for server-only code).

The time prefix is worth more than the extra entropy: ids sort roughly
chronologically, so they index well once they are primary keys in the op log,
and two ids minted in different seconds cannot collide at all. `Page.add()`
still re-rolls against `controlById()`, so uniqueness inside a document is
enforced rather than assumed.

`idFor( seed )` is the deterministic form — `SaltyRNG.Id(s)` hashes instead of
randomising, on a separate generator so it does not disturb the random stream.
That is what will make importing an old `.isp` idempotent: the source has no
ids, so deriving them from stable content means a re-import yields the same
ids rather than a duplicate set.

Two earlier attempts were worse:
`Math.random().toString(36).slice(2,10)` produced short strings when the double
had a short base-36 expansion (`0.5` → the single character `"i"`), and a
hand-rolled `crypto.getRandomValues` had the length fixed but no time prefix
and no relationship to the rest of the stack.

## The property panel

`Edit` / `Edit General` generate a form from the control's `properties` schema.
This is what declaring schemas was for: `clock_addon.c` spent ~70 lines on
`GetControl`/`SetCheckState`/`GetCheckState` pairs mirrored in both directions,
per control. One builder now serves every control that will ever exist,
including ones a plugin registers after the builder was written.

Edits apply **live** — seeing the ring change colour as you pick it is the
point — and Cancel restores a snapshot taken on open.

The `Args` field type is the interesting one: its schema is not known to the
panel, it comes from whichever action or source the sibling selector chose. So
picking `enableParticipant` makes its `hall` argument appear, and a plugin's
action can be wired to a button entirely in the UI.

Notes on popups2, since they cost time to find:

- **The UA popover defaults are never neutralised**, which breaks menus twice
  over. `[popover]` gets `inset:0; margin:auto` from the user-agent sheet, and
  `menu.js` `show()` sets only `left`/`top` — so `right:0` still applies and the
  box auto-centres in the span between the two edges. A right-click at x=145
  opened the menu at x=715; at x=723 it opened at 1004; only at the far right
  edge did it land on the cursor. Fix is `right:auto; bottom:auto; margin:0`.
- **`styles.css:370` hides every menu.** `[class^="popup-menu"]` sets
  `visibility:hidden` and nothing ever sets it visible again — `show()` calls
  `showPopover()`, which puts the element in the top layer but does not touch
  visibility. The menu opens, sizes and positions correctly, and is completely
  invisible. Looks like the Popover-API rewrite dropped the old JS visibility
  toggle without adding a `:popover-open` rule to replace it.

Both of the above were **fixed upstream in popups2 itself**, in `styles.css` and
`dark-styles.css`, which now carry `:popover-open` rules and the explanation
inline. `editor.css` only themes menus; it does not work around them.

- Use **`makeTextInput`**, not `makeTextField`. The latter renders a read-only
  `SPAN`, and its handler calls `setValue(..., control.value, ...)` — but
  `control.value` on a `SPAN` is `undefined`, so editing one writes `undefined`
  into the bound field. `makeNameInput` is display-plus-rename-dialog, too
  heavy for a grid.
- The frame defaults to `rgba(150,150,150,.75)` and the caption to aquamarine;
  both need overriding (`.frameContainer`, `.frameContent`, `.frameCaption`)
  or the panel is unreadable over a live canvas.
- Colour keeps a native `<input type=color>`; a text box is a miserable way to
  pick a colour.

### Dialog tiers: panel < notice < alert

Three levels of how much a frame should take your eye, in `css/editor.css`.

| tier | selector | look |
|---|---|---|
| panel | `[class^="frameContainer"]` | editor chrome; recedes |
| notice | `[class*="frameContainer"][class*="-notice"]` | lifted surface, accent caption |
| alert | `.alert-form` | deep red `#350000`, white text, red ring |

**The alert keeps one identity across themes** rather than inverting against
each. A pale frame reads as "a dialog appeared"; deep red with white text reads
as *alarm*, which is the job. An alert that changed colour between light and
dark would be a worse signal, not a better-matched one — you want it
recognisable as itself whichever theme is running.

(A pale-inverted alert was tried first, on the theory that inverting against
the surrounding chrome is hardest to overlook. It is certainly *visible*, but
visible is not the same as alarming, and the red wins on the axis that matters.)

White on `#350000` measures **18.2:1**, so contrast is not what is being traded
away; only the surrounding chrome differs between themes, via
`:root[data-theme="light"]`.

Two selector traps, both the same shape:

- **A `suffix` lands between the base and the kind.** `SimpleNotice` forces
  `-notice`, so its frame is `frameContainer-notice` (and
  `frameContainer-mysuffix-notice` when a caller adds one). An exact
  `.frameContainer` rule matches none of them, which is why notices kept
  rendering aquamarine while every other panel themed correctly. Match on both
  fragments, not a prefix.
- **`[class^="button"]` also matches `buttonInner`.** popups2 shipped
  `[class^="button"]:hover` and `[class^="buttonInner"]:hover` with different
  colours, so the inner picked up the outer rule and then overrode it — the
  label and the button's padding lit differently, implying two click targets
  where there is one. Fixed upstream: the hover belongs to the button
  (`:not([class^="buttonInner"])`), and the inner follows as a descendant.

The alert also had to have `width:auto; margin:0` forced on its content:
popups2 gives it `width:100%` *and* `margin:5px`, and margins sit outside
`max-width`, so it overflowed its own frame by exactly 10px.

## Idle and the screen saver

Pages marked **Screensaver page** are shown when the shell goes idle, and the
previous page returns on the next activity. The flag lives on the *page* (so
renaming it cannot detach the screen saver), the timeout on the *canvas* (there
is one shell). `0` disables it; expect hours rather than minutes.

**Several pages may be marked**, and each carries its own **Show for (s)** — so
an attract loop is built out of ordinary pages rather than a special slideshow
control, and page order is loop order. `0` seconds holds that page until
activity, which is also what a lone screensaver page does. The set is recomputed
on every step, so editing it in another window takes effect on the next turn
rather than at the next idle.

**Runtime only.** The designer must never blank itself while you are arranging
a layout, which is why the watcher is wired in `index.js` and not in the shared
renderer.

### A cross-origin frame leaks nothing

This is the constraint the whole design follows from. No input event crosses an
iframe boundary, `contentWindow` is opaque, and there is no polling trick — it
is a browser security boundary, not a gap here. A station showing only an
embedded application would therefore blank *while someone was using it*.

So the framed client reports for itself, and `web/Web Page` relays it:

```js
// in the framed page (its preload is the natural place)
const ping = () => parent.postMessage( { type: "tt-activity" }, "<shell origin>" );
for( const ev of [ "pointerdown", "keydown", "wheel", "touchstart" ] )
    addEventListener( ev, ping, { passive: true, capture: true } );
```

Two control properties gate it:

| property | default | meaning |
|---|---|---|
| Report activity | on | relay `tt-activity` from this frame |
| May request screensaver | **off** | honour `tt-screensaver` from this frame |

The second defaults off because it is a different kind of message: reporting
that someone is present is a *report*, asking the shell to blank is an
*instruction*, and a framed page should not get the second for free.

**The source check is the security boundary**, and it is
`event.source === frame.contentWindow` rather than an origin string comparison.
That identifies *this* frame, not anything that merely shares its origin — so
another window, or a second frame on the same host, cannot keep a station awake
or blank it. Verified: a `postMessage` from the shell's own window is ignored,
the same message from the frame is relayed.

### Why it polls

`watchIdle()` compares `Date.now()` against the last activity every 30s rather
than arming one long `setTimeout`. A timer set for four hours does not survive
the machine sleeping or the tab being throttled in any predictable way; a
timestamp comparison does. `trigger()` forces the idle state on demand without
pretending the timer fired, which is what the on-demand path uses.

`npm test` drives the clock rather than waiting, so a four-hour timeout is
exercised in milliseconds — including going idle, waking, and going idle again.

## Page embeds: a fragment in the shell's realm

A page can load an HTML fragment into a shadow root behind its controls, set as
**Embed fragment** in Page properties. It uses popups2's `fillFromURL`, which
re-hosts the fragment's `<script>` tags in **this** document.

That is the whole point, and the whole risk. Against a `web/Web Page` control:

| | Web Page (iframe) | page embed (fillFromURL) |
|---|---|---|
| realm | its own | **the shell's** |
| can call shell APIs | no | yes |
| activity visible to idle | only via `tt-activity` relay | **directly** |
| sandbox | yes, configurable | **none** |
| cross-origin | yes | fetch, so same-origin or CORS |

So the embed is for content you control, and the iframe for content you do not.

**This is also what "multi-window" means for an embedded application.** popups2
attaches a popup to `document.body` by default (`core/popup.js:181`), so an app
written *as popups* — which the sideplayr services largely are — behaves quite
differently under the two:

| | in an iframe | as a page embed |
|---|---|---|
| its popups attach to | the iframe's body | **the shell's body** |
| so they float over | that rectangle only | the whole shell window |
| analogy | a rooted X display | **multi-window X** |

Framing a popup-based application therefore traps its windows inside a mostly
empty rectangle. Embedding it lets them float where they were meant to.

**The designer does not execute embeds.** A fragment with full DOM access,
running while you arrange a layout, can reach straight into the editor — so
`editor.js` constructs its view with `{ embeds: false }` and design time shows a
placeholder naming the URL. The runtime gets the real thing.

The module is imported dynamically, so a document with no embeds never pays for
it, and a page change while the import and fetch are in flight is checked for
before the result is used.

## Reordering pages

A **Pages** button beside Plugins, because page order stopped being cosmetic:
it is the attract loop's order *and* what `(next)` steps through. The panel
lists live pages with up/down, marks which are in the screensaver loop and with
what hold, and clicking a name shows that page.

`Canvas.movePage()` swaps in the **full** `pages` array while choosing the
neighbour from the *live* ones. So a destroyed page sitting between two live
pages keeps its slot and reappears where it was if undestroyed, rather than
being shuffled by an operation that never mentioned it.

**Undo stores the sequence, never a copy.** `capturePageOrder()` is a shallow
`slice()`, deliberately not `captureCanvas( canvas, "pages" )` — cloning would
replace every `Page` with a copy and undo would swap the live objects out from
under the view, the controls' back-references, and anything else holding a
page. Hence a `pageOrder` record kind that compares by identity and restores by
reassigning the array.

## Symbolic page targets

`nextPage` accepts more than a page title. The picker offers these first:

| token | meaning |
|---|---|
| `(first)` | first live page |
| `(next)` / `(previous)` | step through live pages, wrapping |
| `(next screensaver)` | step through the attract loop, wrapping |

Parenthesised so they cannot collide with a page someone named "next", and
resolved in `Canvas.resolvePage()` rather than at the button — `(next)` depends
on where you are now, and resolving centrally means a control, an action and a
timer all agree on what it means. Destroyed pages drop out of the stepping.

They also survive renaming and reordering, which a stored title cannot; a
`(next screensaver)` button on an attract page steps the loop without naming
any page at all.

## Events

`sack.vfs/Events2` — `on(name, fn)` subscribes, `on(name, args)` dispatches,
`off(name, fn)` unsubscribes. Both `CanvasView` and `EditOverlay` extend it.

The one rule to remember: **Events2 always spreads an array payload into the
callback's parameters**, so a dispatch wraps its payload in an array — and a
payload that *is* an array gets wrapped twice:

```js
this.on( "pageShown", [ page ] );          // callback gets ( page )
this.on( "selection", [ this.selection ] );// callback gets ( array )
this.on( "resize", [] );                   // callback gets ()
```

`on()` returns no unsubscribe token, so anything that needs to detach keeps the
`[event, handler]` pair and calls `off()` — see `EditOverlay.#watch`.

## Applications

**A document is an application.** The server holds many; `?doc=Name` picks one,
for both the runtime and the designer. A launcher needs no special support: it
is a document whose table is bound to the built-in `documents` source.

**Interfacing with an existing application** — the sideplayr case — happens at
the action/source registry, which is this system's ISOM seam. A server-side
application module registers actions (imperative: launch, stop, restart) and
sources (data: log tail, running tasks) that proxy to whatever the real
application exposes: REST, a child process, a database. The shell itself does
not change, and the designer picks the new behaviour out of the menu because
the schemas travel.

The client half of an application — its `%variables`, its client actions, its
own control modules — lives under `ui/apps/`. That separation matters: a
document loaded from storage still says `%Clock`, and something has to know
what Clock is. Folding variable definitions into the seed-document function is
exactly what broke substitution once documents started coming from the server.

## Creating controls: the right-click tree

Control names are **paths**, as they were in the C registry (`pages.h` spelled
the page changer `"page/Page Changer"`). A `/` separates menu levels, so the
create-control menu is just the registry drawn as a tree:

```
Create control ▸ security ▸ Session
                 Button
                 Text Label
```

Built with popups2's `createPopupMenu` on right-click, the way the C editor did
it. Registering `"security/Login"` makes it appear under `security` with no
menu code to change.

**Marking a region is how you create a control.** Rubber-band the space it
should occupy, then pick the type from the right-click menu — rather than
placing a default-sized control and resizing it afterwards. Snapping the two
corners independently can collapse the rectangle to nothing (sweep 1200→1300
against a 417-unit cell and both land on 1250), so a region is widened to one
whole cell rather than rejected: the sweep said where, it just did not say how
big.

Three menus, following the C split:

| right-click | menu |
|---|---|
| a control | Edit, Edit General, Clone, Destroy |
| a marked region | Create control ▸, Clear region |
| the background | Create control ▸, page properties, Create/Rename/Change/Destroy/Undestroy Page, Layer |

Pages are soft-deleted, which is why the original had both Destroy and
Undestroy. The flag is a private field so it never serializes, and `compact()`
drops the pages on the way to storage — undestroy reaches back exactly as far
as the last save.

## Security

Every page and control carries an optional requirement, and the server decides.

### The contract is the verdict, not the vocabulary

Different logins do not share a permission model and are not made to. A user
database thinks in **roles**; an employee/player split thinks in whether you are
staff at all and at what **level**; the next one will think in something else.
Forcing them through a single `tokens: []` list would make every provider invent
an encoding of its real model into strings, and the document store something
none of them actually means.

So a requirement is **namespaced by provider**, and only that provider reads its
own slice:

```js
control.security = {
    "user-database": { roles: [ "manager" ] },
    "gameproxy":     { staff: true, minLevel: 3 },
};
```

That is the C original's shape, which had it right already:
`AddSecurityContextToken( object, module, token )` and
`GetSecurityContextTokens( object, module, list )` were namespaced by **module**.

The only thing every provider must agree on is the *answer*:

```js
registerSecurityProvider( "gameproxy", {
    test( requirement, session ) { return …; },   // the only required method
    label, describe, edit,                        // optional, for the editor
} );
```

### Three rules

- **AND across providers.** A control is usable when every provider named in its
  requirement allows it, so adding a requirement can only ever restrict.
- **OR is not expressible across providers**, on purpose. It belongs *inside* a
  provider — the only layer that understands its own vocabulary well enough to
  know what "either of these" means.
- **Unknown providers fail closed.** A requirement naming a plugin that is not
  loaded denies. A check nobody can perform has not been satisfied, and treating
  a missing plugin as permission would make disabling one a way to unlock
  everything it guarded.

### The server withholds; the client only avoids drawing

`server/security.mjs` is a separate module from `ui/core/security.js` on
purpose. They must agree on the *shape*; they must not be mistakable for each
other. A plugin's server half registers the real check, its client half may
register a cheaper approximation or none at all.

`loadDocument` now sends a **filtered snapshot**: controls this session may not
see are removed before the document goes on the wire. Hiding a control in the
browser stops it being drawn and nothing more — a client reading the document
off the wire would still have had it. The filtering is structural and restores
the server's cached model afterwards, because that model is what resolves a
later `invoke`.

A page the session may not open is **emptied, not removed**: a button elsewhere
may still name it, and a missing page turns a denial into a broken navigation.

**The designer is exempt, twice over.** It asks for the document with
`editing: true` (unfiltered) and renders with `security: false` — you cannot
arrange a layout around controls you cannot see. That request is itself the
privileged one, and is where an editing permission attaches.

`npm test` covers the seam with two providers that share no vocabulary at all —
roles versus a staff flag plus a numeric level — plus AND, fail-closed, and an
assertion that a withheld control's id and text appear **nowhere** in the wire
text.

## Glare sets (button skins)

A glare set is the original's mask + up + down quartet. The mask is a
three-channel image where each of R, G, B is an **independent coverage mask**
taking its own RGBA colour; the lens layers are ~18% mean alpha specular drawn
*over the text*, so the text picks up the highlight.

**The browser does have the colour-transform matrix** — SVG `<feColorMatrix>`,
reachable from CSS as `filter:url(#id)`, the same 5x4 object as GDI+
`ColorMatrix` in C#. Three-channel colourisation is exactly a linear transform,
so `multi shade` is *one matrix in one GPU pass* whose first three columns are
the three colours. No canvas, no pixel loop, no readback.

This is why colourising server-side would be a mistake: a status ring that
changes with mode would need an image per state or a request per change.
Client-side it is an attribute rewrite — measured at **0.011ms per recolour,
with zero additional image requests**.

Two things that are easy to get wrong:

- `color-interpolation-filters="sRGB"` is required; the linearRGB default
  silently washes the colours out.
- the alpha row derives alpha from the colour channels, so an `feComposite
  operator="in"` re-clips to the source alpha and keeps the antialiased edge.

### Channel roles are declared, not assumed

Measured from `colorLayer.png`: mean RGB is `(0, 48, 146)` and **no pixel has
both R and G lit** — the channels are disjoint, and red is unused. G is the
ring, B is the body, matching the original config where `Enable Participant`
set `secondary color=$FF00FF00` to make the ring green. So a set names them:

```js
registerGlareSet( "bicolor square", {
	mask: "images/colorLayer.png",
	up: "images/defaultLens.png", down: "images/pressedLens.png",
	shade: "multi",
	channels: [ null, "secondary", "color" ],   // R unused, G ring, B body
} );
```

A glare set need not be images at all — the `flat` set is pure CSS, which is
sharper at any size and cheaper than a filtered bitmap for a plain rounded
rect. Gradients cannot reproduce an artist-authored specular swirl, so both
kinds live in one registry and are interchangeable by name.

## One instance per port

`server/singleton.mjs`, run before anything opens the database — which is why
`server.mjs` imports `protocol.mjs` *dynamically*, after awaiting it.

**Two instances on one SQLite file wedge each other permanently**, and the
symptom names nothing useful. `autoTransact` holds a write transaction open for
the life of the process; with default journalling a writer takes an exclusive
lock, and with no busy timeout the second connection waits for it *forever*
rather than failing. The blocked statement never settles, `serial()` never
advances past it, and every later request — `loadDocument` included — hangs
behind it. What you see is a blank editor and "timed out waiting for document",
with a perfectly good document sitting in the file. (This actually happened,
2026-08-25.)

Whoever owns the port owns the database, so **the port is the lock** — one
check instead of two, and it cannot disagree with itself the way a lock file
can after a hard kill. Same approach as the launcher service, minus its
command-line matching: the port is what actually conflicts, and matching on
args would also stop an instance deliberately started on another port.

Four things came out of it:

- **Pin the program name on both sides.** A stop signal is delivered through
  `CreateNamedEvent`, whose name comes from the *target's* `GetProgramName()`.
  A name that does not match is not an error; it is delivered to nobody and the
  stop silently does nothing.

  The default is not the problem: `GetProgramName()` is argv[0] with path and
  extension stripped, which yields `"node"` for every spelling seen here
  (`node.exe`, `..\node\node`, `M:\...\node\node.exe`, `C:\Users\...\node.exe`),
  and the event name includes the pid, so it is already unique per process.

  It breaks when one side has been given a custom name and the other still
  guesses `"node"` — which is exactly what happens mid-migration to
  `sack.system.programName`. So the server assigns
  `sack.system.programName = PROGRAM_NAME` before anything creates the event,
  and `singleton.mjs` signals that same constant: agreement by construction
  rather than by both happening to default. The event becomes
  `Global\Tessera Trellis Server(pid):exit`.

  (`Task.stop`'s 4th argument identifies the executable and does *not* name the
  event. Pass `binary` rather than `bin` anyway — `bin` is however a process was
  invoked, while `binary` is the canonical device path and is identical across
  all four spellings above.)

- **Escalation is the guarantee**, not the signal. Ask politely, wait 3s, then
  `Task.kill`. A port that changes to a *different* pid means something else
  grabbed it, and we decline to start rather than stop a stranger.
- **`enableExitSignal` so a handover commits.** A hard kill loses whatever
  autoTransact had not yet flushed, and being replaced is exactly when that
  happens. Measured: `close()` alone **commits** the open transaction (tested
  both ways on throwaway files) — so `closeDatabase()` only closes. An explicit
  `commit()` first is redundant and logs "Commit issued with no transaction
  started" on every handover.
- **A failed load must not fall back to the seed document.** It shows a fatal
  banner and stops. Quietly handing back the demo would let the next Save write
  it over real work.

Belt and braces in `db.mjs`: WAL plus `busy_timeout=5000` (both before
`autoTransact`, which refuses `journal_mode` from inside a transaction), and
`serial()` steps over any statement exceeding 15s. Contention now degrades to
an error the queue can pass, instead of a permanent hang. The singleton is the
fix; this is the net.

## Storage

SQLite (`tessera-trellis.db`, override with `TT_DB`). A document is a snapshot
only — see *Undo is per-editor and is not persisted* above. The `document_ops`
table and its API remain but are unused.

Two things this needed:

- **`db.autoTransact(true)`** — without it every statement is its own fsync:
  measured 7019ms for 50 inserts, versus **3ms** with it. It must be set last,
  since it opens a transaction immediately and SQLite refuses `PRAGMA
  journal_mode=WAL` from inside one.
- **a serialisation queue** — `db.run()` resolves a promise, so work can land
  on a worker thread while SQLite may be built single-threaded. Every call goes
  through `serial()`, so exactly one statement is in flight regardless of how
  many websocket clients ask at once.

`makeTable()` merges, so adding a column to the CREATE statement migrates an
existing file; there is no separate migration step. Changing a column *type*
is not covered.

Timestamps must be bound as SQL text (`dbUtil.getSqlDateTime`) — a `Date`
object is not a bindable parameter type.

## Layout

```
server/
  protocol.mjs      HTTP+WS; serves ui/ and /node_modules via sack.vfs/server
  server.mjs        entry point
ui/
  core/             coords, registry, properties, variables, security, document
  render/           canvas-view.js   — the renderer
  edit/             overlay.js       — editor only
  controls/         button, label, session
  index.html/.js    runtime
  editor.html/.js   designer
```

## Status

Working: grid model, renderer, control registry, property schemas, `%variable`
substitution with live re-render, drag/resize/marquee/nudge with snap, JSOX
round trip, page navigation, glare-set button skins, a shared header/footer
layer, named actions and data sources resolved through the document, a
right-click create tree with region marking, a schema-generated property
panel, SQLite persistence over the websocket protocol, plugin selection via
`config.jsox`, and editor-local undo/redo.

Next: the `.isp` importer.

### Undo is per-editor and is not persisted

Decided 2026-08-25, reversing the earlier snapshot-plus-op-log plan: individual
ops are **not** saved. Storage stays a whole snapshot.

An undo stack is a property of an editing session, not of a document. Two
editors drifting out of sync is acceptable — this is not far from a shared
whiteboard — but **you must not be able to undo someone else's work**, and a
server-side log shared by every window is exactly the shape that lets you.
Keeping the stack client-local makes that impossible by construction rather
than by rule.

So an undo entry must be invalidated when the thing it describes has since been
changed by someone else, rather than blindly re-applying an inverse. (The
eraser-over-someone's-line case has no clean answer and does not need one here.)

`document_ops` and `db.mjs`'s `appendOp` / `opsSince` / `latestSeq` / `trimOps`
are left over from the abandoned plan and are dead code — nothing calls them.
Kept deliberately rather than dropped.

### What is an operation?

`ui/edit/history.js`. A **completed user gesture that changed the document** —
never an individual mutation:

| gesture | entry |
|---|---|
| drag / resize | one per gesture (pointerdown‥pointerup); below the 3px click threshold, none at all |
| nudge | one per keypress, coalesced while the selection is unchanged |
| create / clone / delete | one each |
| a dialog | **one for the whole session** |
| page + canvas | create, rename, destroy, undestroy, presets, fonts, glares, insets |

**The dialog case is why live editing and undo are not in tension.** The panel
still applies every keystroke live — watching the ring change colour as you pick
it is the point — but the undo *granularity* is the whole dialog session. So the
stack reads exactly the way an apply-on-Okay design would (one entry per dialog,
Cancel leaves no trace), without giving up live preview. Cancel needs no special
case either: it restores first and then records, and an entry whose before and
after match is dropped by arithmetic rather than by a flag. Recording happens in
`close()`, so the caption's X and Escape behave like Okay, as they already did.

Records are **entity-scoped state bags**, not document snapshots and not
closures. Snapshots would be far simpler and are wrong here — undoing one would
stamp a whole document over another editor's concurrent change, the exact thing
that must not happen. Closures go stale the moment an entity is deleted and
recreated; a state bag is just compared and applied.

That comparison is the invalidation rule: before applying, each record checks
that its entity still matches the state the record produced. Records that have
been overtaken are **skipped**, not re-applied, and the count is reported. (With
no document broadcast yet, this currently only fires against later *local*
edits — it is built for the multi-window case rather than exercised by it.)

Two details that are load-bearing:

- A control's record includes its **page and array index**, because array
  position is z-order twice over — DOM sibling order is paint order, and
  `Page.hit()` walks the array backwards. Undoing a delete has to put the
  control back at its old depth, so `CanvasView` grew `addControl(c, page,
  index)` and `reindex()`.
- Undoing a change on a page you are not looking at **switches to that page
  first**. Partly manners, mostly correctness: the renderer only builds
  elements for the visible page and the shared layer.

Gestures use refcounted `begin()`/`touch()`/`commit()`; dialogs use
`capture()`/`record()` instead, because two panels can be open at once and
nesting them into one transaction would let whichever finished first swallow the
other's changes.

**The resource editors** (fonts, glare sets, page properties, style presets)
are wired through the same capture-on-open / record-on-close pair, done once in
`resource-editors.js`'s `panel()` helper rather than per editor. They apply live
and have no Cancel, so one entry per session is the right grain — and a session
that changed nothing records nothing, because before and after match.

`captureCanvas()` clones through **JSOX, not `structuredClone`**. That is not a
style preference: `canvas.styles` holds `Style` instances, and
`structuredClone` strips prototypes — measured, it returns `instanceof Style:
false` with `governs: undefined`, so an undo would appear to work and then kill
the next repaint. JSOX already has the type registered for the document format,
so a round trip revives it. `npm test` asserts the class identity survives, and
that assertion genuinely fails under `structuredClone`.

Two bugs the wiring exposed, both fixed in `panel()`:

- **A non-modal `hide()` raises only `"hide"`, never `"close"`.** The Done
  button calls `hide()`, so the open-panel map was never cleaned up and the next
  request `raise()`d a hidden popup instead of building a fresh one — the menu
  item simply stopped working after its first use. Listen for both events.
- **Closed panels stayed in the DOM.** `hide()` only sets `display:none`, and
  these rebuild from the document each time, so every close left another dead
  frame — enough that a query for `.tt-prop-text` started matching stale copies
  alongside the live one.

`npm test` covers the lot headlessly against the real document model — 28
assertions including z-order restore, nudge coalescing, cancelled dialogs,
stale-record skipping, and redo-branch truncation.
