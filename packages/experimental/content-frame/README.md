# @deepseek-ai/dsh-experimental-content-frame

English | [中文](README.zh.md)

The `page` kind of the service-line shell's content column, and the two ways to control it: a directory of static files on the host, served under one dsh route, shown in an iframe that fills the column — with the agent choosing which of the deployment's pages is in it through the `content_show` tool, and a user choosing directly through the sidebar's page-navigation menu (`@deepseek-ai/dsh-experimental-server-sidebar`), which executes the `show-content-page` command. The application inside is written and deployed by whoever runs the harness; this package neither builds it nor knows what framework it uses.

Seven pieces, one decision each. The node half serves the configured directory under `/content-app`. `content_show` offers the deployment's page list to the model and appends `content/shown` when it chooses. `show-content-page` offers the same page list to a command-executing UI and appends the same event when a user chooses. The `page` extractor turns each shown id into an entry of [`content-surface`](../content-surface/README.md)'s stream, resolved against the page list running now. The `content` projection resolves the last recorded id the same way, for a consumer that wants the column's current page rather than its history. The browser half claims the `page` key of the column's kind slot and keeps one live frame per (session, page) pair. Where the deployment turns it on, `content_read` lets the agent read the page in that frame as a numbered structure.

## Trust boundary

**The hosted pages run with the shell's own authority.** They are served from the dsh origin and the iframe carries no `sandbox` attribute, which makes each document same-origin with the shell: it can call the dsh HTTP API — sessions, tools, settings, everything the browser can reach — without any further permission. `root` must therefore name a directory whose contents are trusted exactly as much as the harness itself.

That is the point of the design rather than an oversight. A first-party application in the content column is expected to talk to the harness, and an opaque origin cannot: the API's Origin check rejects `null`, so a `sandbox` without `allow-same-origin` would leave the frame unable to do anything, while a `sandbox` with it removes nothing. Hosting content that should **not** have that authority — agent-generated pages, third-party bundles, anything a user drops in — needs a separate, sandboxed plugin, not a flag here.

## Serving the application

`root` is required and takes no default: which application a deployment hosts is the whole decision this plugin carries. It must be an absolute path to an existing directory; anything else fails the row at load rather than serving an empty frame. The path is resolved through `realpath` once, and every request is checked against that resolved root.

The route deliberately does not behave like the dsh SPA dist server that owns the webserver fallback seat:

- **A miss is 404, never an index fallback.** Falling back would answer a broken asset path with the dsh shell at HTTP 200, and the failure would surface inside the iframe as a blank page with nothing in the network log to read.
- **The content types cover a real static build** — the four font formats, raster images and icons alongside HTML/JS/CSS/JSON. An unknown extension is `application/octet-stream`.
- **Traversal and symlink escapes are 403.** The lexical path must resolve inside the root, and so must the file's real path, so a symlink planted in the directory cannot read outside it.
- **A directory resolves to its `index.html`**, including the bare prefix; a directory without one is a 404.
- **Only GET and HEAD**; anything else is 405 with `Allow: GET, HEAD`.
- **`cache-control: no-cache`**, because the directory is edited in place under a stable URL and a cached entry document would keep serving the previous build.

A second, exact route — `/content-frame/settings` — serves the browser half the configured values it must obey: `cacheSize`, the whole `pages` catalog, and, where the deployment configured page access, the reader's budget and the two deadlines it works inside. It exists because a browser half receives no cordis config at all: the boot manifest carries plugin names, not their `config` blocks. An unreachable or unusable settings document fails the browser row rather than letting the column run on a bound nobody chose. The page catalog travels this same route rather than a second one — the sidebar's page-navigation menu is this route's second reader, matching its shape by convention (hardcoded route path and JSON shape) rather than by importing this package, since a cross-package value import is not this repository's sanctioned way to couple two client-adjacent plugins.

## Who put a page on display

`content/shown` carries a `by: 'agent' | 'user'` field: `content_show` (the model's tool) writes `'agent'`, and `show-content-page` (the sidebar menu's command) writes `'user'`. A log written before this field existed carries neither, and every reader defaults that case to `'agent'` — the tool was the only writer then. The two writers append the identical event under the identical type, so a page shown by a user click and a page shown by the model occupy the same one entry in `content-surface`'s stream (deduplicated by page id) and the same `content` projection value; nothing about which existing kind or projection is used changes with the writer.

The `content` projection deliberately drops `by` — it answers "what page is on display," which needs no writer distinction — while the `page` extractor keeps it in its stored and resolved payload, for a renderer that wants to show the distinction later; today's frame renderer does not (see Known Limitations).

## Pages the agent may show

`pages` is the deployment's whole vocabulary for the column, and at least one entry is required — `content_show` exists to choose among them. Each page declares an `id` the agent passes, a `title` the user reads, a `description` written in the agent's terms (it becomes the catalogue line in the tool description), and a same-origin `url`. A URL that names a scheme or a host fails the row at load: the frame carries the shell's authority, so it may only address the dsh origin.

`defaultPage` names the page the `content` projection reports before the agent has chosen anything and after it clears the column. **The column itself does not show it** — it lists what a session produced, and a default page is not something any session produced, so a session that has shown nothing gets the column's empty-state notice. `id` may not be `none`, which the tool reserves for clearing.

`homePage` names the page `@deepseek-ai/dsh-experimental-server-sidebar`'s workbench shows automatically the first time a session lands on a blank draft. Unlike `defaultPage`, this is not a projection value read passively — the sidebar issues an actual `/show-content-page` invocation, so the column really does show the page and the usual `content/shown` log record follows. Read this package's `Config` type for the exact difference; the sidebar package is this field's only consumer.

## One live frame per session and page

The column's kind slot is `root`-scoped and the column keeps this seat mounted even while another kind is on display, so the browser half keeps every cached frame mounted at once with all but the current one hidden. A page the user returns to therefore looks exactly as it was left — scroll position, form state, whatever the document holds — because the element was never destroyed, across a switch to another page, to a chart, or to another session. `cacheSize` bounds how many survive, counted over (session, page) pairs; past it the least recently shown one is dropped and reloads when it comes back. The frame on display is never the one dropped.

## Reading the page the agent put there

`pageAccess` gives the agent `content_read`: one call answers with the page the user is looking at as a numbered structure — containers, controls, headings and text, each control carrying a ref like `e12` that a later call can point at. Structure reaches the model and data does not: a table reports its header, its size and one sample row, and lists rows only when a read names that table by ref or matches one by its text; a password box reports that it is there and never what it holds; a page asking for a sign-in answers with a refusal instead of a listing.

**Absent is off, and absent is the default.** Without the block there are no tools, no route, no pending projection, no `pageAccess` field in the settings document, and no reader in the browser — a deployment that only shows pages does not pay for a capability it did not ask for. Present with an empty object takes every default. The eight fields — `claimTimeoutMs`, `readTimeoutMs`, `pinMs`, `settleQuietMs`, `outlineChars`, `actTimeoutMs`, `maxSteps`, `settleMaxMs` — are documented on the `Config` type; `outlineChars` is the one that decides what a read costs in context, because it is the character budget the listing is rendered under. It has a floor of 1000, refused at load: a listing's first row is rendered however long it is, and below that floor an ordinary table's first row is already past what the report route takes. Three have ceilings instead of floors, all refused at load: `settleQuietMs` must fit inside the settle share of `readTimeoutMs`, because a quiet window the budget cannot hold would make every read report a page that never settled; `settleMaxMs` must be at least `settleQuietMs` and fit inside `actTimeoutMs`, for the same reason from both ends; and `maxSteps` is capped at 100, which is what keeps a report of steps inside the envelope the report route allows.

## Acting on the page the user is looking at

The same block gives the agent `content_act`: one call carries up to `maxSteps` steps — `click`, `fill`, `select`, `press`, `wait` — run in order against the page in front of the user and stopping at the first failure. Every step but `wait` names its element twice, by the `ref` a read returned and by the `label` that read printed, and the browser checks the name before it acts: a page that re-rendered its table between the read and the call has the same refs pointing at different rows, and the check is what stops the call rather than pressing whatever now sits there. Three more endings stop a step — an element the page no longer has, one behind a dialog the page has put in front of the user, and one the page has switched off.

The events are the page's own. A click is the whole pointer sequence a user produces, because a framework listening for `mousedown` alone never sees a bare `click`; a fill goes through the prototype's value setter, because React and Vue both track the value they last wrote and an assigned `el.value` is a change they undo on the next render; a key is three events with no form submitted behind them, because what Enter means is the page's decision. A `select` is either the platform's own `<select>` or the two clicks a drawn picker takes. Between steps the page is given `settleQuietMs` to go quiet, bounded per step by `settleMaxMs`.

**One call is one approval request.** A `tools/pre-execute` listener escalates every call of this tool to a request composed from the arguments and nothing else: nothing has reached a browser when it is written, so it names the column's front entry the way the user sees it rather than a page title the host has not got. That is the other reason `label` is required on every step — the user is told what will be clicked and filled, and the only place those names can come from is the call itself. The listener delegates first, so a policy that would deny the call still denies it; a deployment composing no approval service runs no steps at all, which is the kernel's own degrade for a call that asks.

**What the page did on its own comes back with the answer.** For the length of the call — and no longer — the seat watches the document for text that appears and goes away, listens for route changes, and stands in for `confirm`/`alert`/`prompt` and `window.open`: the first three because they block the frame's event loop until something answers and the seat is that something, the last because a window opened behind the console is one nobody will look at. Both stand-ins are put back when the call ends, including where a step threw. `dialogs` says how a native dialog is answered — `cancel` by default; `accept` is refused unless the approval request the user read said the page's own confirmation would be confirmed too, which no standing allowance and no policy that never asks can produce.

The answer is three sections every time, in the same order: what ran, what the page did on its own, and a whole fresh reading of the page at the deployment's own budget. The last one is what makes a following call possible without reading again, since the refs it names are current. A `fill` into a password box is reported as having filled it and never with what.

### The channel

A host cannot address a browser, so the call travels the other way. Both tools share it. The tool body writes nothing: it registers a wait and publishes the call in the session's own `contentAccess` projection, which every connected browser already receives. The page seat showing that session claims the call on `POST /content-frame/claim`, does the work — walking the frame's document, or running the steps against it — and posts the answer to `POST /content-frame/report`. Only the claiming tab's report is taken, which is why the claim is a round trip rather than an announcement, and it is also why two consoles open on one session run one copy of a set of steps rather than two. What differs between the two tools is the document posted back, discriminated by its own status; the tool that opened the wait is what decides whether the document it was handed answers its own call.

Two deadlines, because "no console is open" and "the console that answered went quiet" are different facts and the model acts differently on each. A call unclaimed within `claimTimeoutMs` is told no console is showing this session — and, for a set of steps, that nothing was done; a claimed read unanswered within `readTimeoutMs` is told to retry once, while a claimed set of steps unanswered within `actTimeoutMs` is told the steps may have run partially or fully and to read the page before deciding, because that is the one ending where nothing on this side knows what happened. One session's consecutive reads stick to one tab: the tab that last answered is preferred for `pinMs`, and another tab's claim is held briefly so the preferred one can take it first. Refs name elements of one document, so two consoles answering alternate reads would hand the model refs that name nothing.

Neither deadline is spent on a single attempt. A claim the host does not know yet is bid again for as long as the call is on the session's pending list, at an interval that doubles from 200ms to one second — the seat's own bidding is bounded by the call still waiting, never by a clock. That is what an approval needs: `content_act` registers its wait only after a person has answered its request, so every claim before that is answered "unknown", and a seat that gave up at the host's claim window would stop bidding while the user is still reading. A claim that never lands — a dropped request, a moment offline — is bid again the same way, and a listing whose first post never lands is posted once more: one dropped request must not be what tells the model there is no console, with the console in front of the user the whole time. Within the report deadline the seat spends at most half on a page that is still loading, because the host started counting the moment it granted the claim and the walk and the trip back need the rest.

The reading half lives in the page seat because that is the only placement holding the frame elements. Visibility and geometry are asked of each element's own window rather than the top one — a frame's layout belongs to that frame — and a tab that is not visible claims nothing, because the read is defined as the page in front of the user.

## Reading the page in the frame

`src/client/access/` reads the document in the frame as numbered structure — the regions, the controls, and the shape of each table — for a model that cannot see it. The rules it is written by, and what each of them gives up, are recorded in [the reading Agent Note](../../../.agents/notes/implemented/feature/2026-09-02-content-snapshot-engine.md). Two widgets no specification names are found by the word a page's own markup carries: the strip that pages a table (`pagination`) and the trail saying where the user is (`breadcrumb`), each read where a class carries the word or a navigation region is labelled with it.

### What a console table reads as

- **A table drawn again for each pinned column is one table.** A component library pins a column by drawing the whole table a second time over the top of itself, with the contents of every cell it does not pin hidden inside the cell, so the page holds several tables where the user sees one. Tables drawn over each other with a row for each row are read as the pieces of one table, and each column is taken from the piece that draws it; the columns line up by their position in the row, so a piece drawing fewer cells than the table has columns lines up from the left. Two tables the page draws one after the other are two tables however alike they are.
- **A table a strip pages counts the rows on display.** The strip a page draws under a table pages it however many copies of that table stand between the two, so a table pinned column by column is paged by the strip drawn after the last copy; a strip between two different tables pages the one above it alone, and a strip pages a table only where the two stand in the same region — a table no region encloses is paged by no strip inside one, and a strip outside the table's region pages nothing. A navigation landmark drawn directly around a strip, nested landmarks included, is part of the pager rather than a region it stands in, so Bootstrap's `<nav><ul class="pagination">` pages the table the `nav` is drawn beside — and a landmark holding the table as well is simply the region the two share. Any other element between the landmark and the strip ends that reading, leaving the landmark a region like any other. A paged table reads as `e30 table 20 rows on this page × 21 cols` and carries the strip's own words on a `pagination:` line, in a whole-page read and in a read scoped to that table alike; an unpaged one reads as `e30 table 20 rows × 21 cols`. Nothing is read out of the strip: how many rows there are, and in which language the page says so, is the page's to say.
- **A cell offers the things a page draws in it to act on.** A click target the page marks with a pointer cursor is named `clickable` and given a ref inside a cell exactly as it is anywhere else. The commands of a table row are often drawn with neither — see the icon rule below.

### What an icon a page draws as a command reads as

- **An icon reads as `icon "edit"`, with a ref.** The row commands of the console this rule was written for are `<i class="el-tooltip operation-modify el-icon-edit">` and an icon inside the wrapper a confirmation puts around it: no role, no label, no title, no pointer cursor. Nothing a specification defines says they are there, so an inline element drawing no words of its own whose class carries the word `icon` is read as one, inside a table cell, a toolbar, or a list — the places a page draws icons as the commands it offers rather than as decoration. A name the page wrote outranks the class as usual.
- **An icon drawn as an inline `svg` is read the same way.** antd v4 and Element Plus draw the shape in the document instead of in a font, and Bootstrap Icons ships a sprite beside its font, so the name is in the classes of the wrapper (`<i class="el-icon">`), in the symbol the drawing points at (`<use href="#icon-edit">` says `edit`, `<use href="#bi-pencil">` says `pencil`), or in the drawing's own `title`. A symbol id names the drawing whatever it is called; only a class has to carry the word `icon`. A wrapper drawing no words of its own and holding nothing but one drawing is the icon, and the drawing under it prints no row, so one icon is one ref: where the wrapper's classes name nothing, the drawing it holds names it, and where both say a word the class wins. A drawing that names itself in none of those places is decoration and prints nothing: pages draw far too many of those to give each one a row.
- **This is a heuristic keyed to a page's own markup**, the only one in the package that names an element — the strip and the trail above are found by the same kind of class word and take no name from it. Just the word `icon` counts, in any class token holding it, and no library prefix is matched: the name is what the class writes after the word, so `el-icon-edit` says `edit`, `anticon anticon-delete` says `delete`, and `icon-trash` says `trash`, while a class ending at the word — `iconfont`, `el-icon`, `edit-icon` — marks an icon and names it nothing, printing a ref and no name. An icon font that never writes the word at all — `fa-trash`, `mdi-pencil`, Bootstrap's own `bi-pencil` — reaches this read as nothing. **It retires** when an adapter can hear the framework's own click listeners, which is what the element really carries.

### What a console form reads as

- **A field is named by the `label` drawn in front of it.** A form that ties no label to its field is named by the last `label` drawn before it, inside the smallest element holding both, as far out as the region the field stands in; that label then prints once, as the field's name. Anything else the reader can act on between the two ends the search, and any other run of the page — a notice, a heading, a caption — names nothing and keeps its own row.
- **A field the page asks for says so.** `(required)` follows a field the page marks with `required` or `aria-required`, and one whose label the page draws a star beside — the mark a form draws with a stylesheet rather than writing it in the document. Every label the page ties to the field is read for it, `label for=` and `aria-labelledby` included. `drawnAround` injects that reading (`::before` and `::after`), defaulting to the computed styles of the window that draws the document.
- **A picker drawn in two halves is one field.** A box the reader cannot type into says `(readonly)`, and the nameless arrow the page draws inside the same element to open what the field offers prints on the field's row as `[e4 opens]` rather than as a row of its own.
## What the agent knows about the column

The column is drawn by the browser, so nothing in it reaches the model unless this package puts it there. Three facts do, by three different routes, each chosen for how often it changes.

**A page the user opened is announced once, in the conversation.** `show-content-page` injects one sentence — `The user opened the page "<title>" in the content column (内容区); it is in front now.` — as a plugin-sourced `user/message`, after the `content/shown` append, so the log carries the fact before the sentence about it. `inject` queues it for the next pre-step without waking the driver: opening a page is not a question, and an idle agent stays idle until the user says something. It is durable from the moment it is queued — the inbox splice carrying it is a session event of its own — and becomes a `user/message` when a driver claims it. `content_show` injects nothing — the agent already knows what it did.

**The application's own routing is a session event.** The browser half watches the frame in front for `load`, `hashchange` and `popstate`, and — because none of the three fires for `history.pushState`, which is how every current router changes route in history mode — polls the frame's own `location.href` every `navigationPollMs`. Everything the four signals produce goes through one 300ms settling window, is compared against the last address reported for that frame, and becomes one `content/navigated` event carrying the page id, the path, the document title and `by: 'user'`. A frame that has left the dsh origin answers every read with a `SecurityError` and the watch reports nothing; the frame's own `history` is never patched, because that document belongs to the deployment and an application wrapping it afterwards would take the patch straight back out.

**Where the column stands is a prompt context, not a message.** `content:column` (order 130) lists what the column holds, newest first, with the entry in front marked and — for a page whose frame has moved away from its configured address — the address it is at now. What it costs is the deployment's to set: `contextEntries` bounds how many it lists and `contextFieldChars` how much of a name each line carries, because this block rides every request and a console whose users keep a dozen things open pays for it on all of them. It is registered as a *context* rather than a section for the reason `approval:policy` is: the value changes as the user works, and a context is materialized after the retained history, so a column that moved does not rewrite the stable system-prompt prefix the provider caches. Nothing in it is timestamped: a relative time would differ between a live run and its replay, and the conversation already carries the order things happened in.

All three fold from this session's own log — `contentSurface`'s entry stream and this package's `contentPages` state, which records who opened each page and where its frame went. `contentPages` is host-only: no browser reads it, so it carries no `wire`.

## Reading a page that has not finished drawing itself

A frame that has fired `load` is not a page that is done: a single-page application fetches, paints, and repaints for as long as it takes, and a read landing in the middle of that is a listing of a page the user never saw. So a read waits, after the load wait and before the walk: a `MutationObserver` over the frame's document, answering as soon as the document has held still for `settleQuietMs`, and giving up at `readTimeoutMs × 0.25`. The two shares of the report deadline — half for a page still loading, a quarter for one still drawing — leave the walk and the trip back the rest.

The wait's two outcomes both reach the model. A page that never settled is read anyway, with `The page was still changing when this read ran; read again for the settled page.` on its own header line: the listing is a real read of that instant, and reading again is what turns it into a listing of the page as the user has it. And whatever the page marks `aria-busy="true"` while visible is named on a header line of its own, at most three, through the same naming ladder the listing uses. `role="progressbar"` is not a busy mark — a page can draw one as its subject — and no framework's loading class is read, because this reader has never heard of one.

`content/navigated` does not wait: an address change is reported the moment the frame settles at it, and waiting for the page behind that address belongs to reading it. Refs are invalidated by the engine on its own terms — the ref table is reset when the frame loads a new document, a ref whose element left the document resolves to nothing, and a stale `scope` or `after` is refused with a message telling the model to read again.

## Hiding the `show-content-page` command from the chat transcript

A user's page click is a command invocation, and every command leaves a `command/run`/`command/done` pair on the log — the durable record the sidebar menu and every replay rely on. Left alone, `dsh-client-ui-conversation`'s chat view renders that pair as an ordinary command row ("Now showing `<title>` in the content column."): informative for the agent's own commands, redundant for a click the user just made. The browser half registers an empty component into `conversation.chat.commandview`'s `show-content-page` key — the keyed slot every command row dispatches through — so the row's business content never appears.

An empty registrant still leaves a zero-height flex item in the chat column, and the column's `gap: 16px` reserves space for it regardless of height. The browser half also injects one CSS rule collapsing that specific empty row (`[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)`), coupled to two DOM shapes this package does not own — `dsh-client-ui-conversation`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper — see Known Limitations.

## Composition

Neither this package nor the shell is part of any shipped bundle. `overlay/content-column.patch.yml` composes all four over the Web surface — the shell replaces `ui-layout`, `content-surface` folds the session's logged events into the entry stream, `content-column` claims the column the shell opens, and this row contributes the `page` kind:

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: content-surface
      name: '@deepseek-ai/dsh-experimental-content-surface'
    - id: content-column
      name: '@deepseek-ai/dsh-experimental-content-column'
    - id: content-frame
      name: '@deepseek-ai/dsh-experimental-content-frame'
      config:
        root: !!js process.env.DSH_CONTENT_APP_ROOT
        pages:
          - id: home
            title: Home
            description: The hosted application's entry page.
            url: /content-app/
        defaultPage: home
        pageAccess: {}
```

`dsh --profile web --patch <path>` applies it. The overlay reads the directory from the environment so one file serves any application; a deployment that hosts a fixed one writes the literal absolute path in its place. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

The empty `pageAccess` block is this service line's own choice: it takes every default and is what lets the agent see the page it put in front of the user. Drop the line and the column still works exactly as it did.

The tools, the command, the projections, and the page extractor are optional children: a composition without `ctx.tools`, `ctx.commands`, `ctx.sessionProjections`, or `ctx.contentSurface` keeps the routes and shows nothing in the column, and no absence fails the row.

## Model Experience

### The `content_show` offer

#### What the model sees

One tool, `content_show`, with one required `string` parameter, `page`. Its description carries the deployment's whole page list as `id — title — description` lines, so nothing else has to tell the model what may be shown — this package contributes no system-prompt section.

#### Token effect

A fixed description plus one catalogue line per configured page, on every request where the tool is visible. Ten pages cost roughly ten short lines.

#### KV Cache effect

The description is assembled once when the row loads and never varies within a deployment, so the tool block stays byte-identical across requests and the prefix holds. Editing `pages` changes the block and invalidates reuse from it — a configuration change, not something a session can trigger.

### Tool-call result and column state

#### What the model sees

A successful call answers with exactly `Now showing <title> in the content column.` or `Content column cleared.` An id the deployment does not configure answers `Error: unknown page "<id>". Available pages:` followed by the whole catalogue again, so the model corrects itself from the result instead of guessing at a retry; that call changes nothing. A call with no owning session answers `Error: content_show requires an owning agent session`. The `content/shown` session event each successful call appends is UI and replay state, not a second model message.

#### Token effect

Small and fixed-shape on success. A rejection costs one catalogue again, which is the price of making it self-correcting.

#### KV Cache effect

Append-only; results follow the reusable request prefix and invalidate nothing already cached.

### The `content_read` offer

#### What the model sees

One tool, `content_read`, offered only where the deployment configured `pageAccess`. Four optional parameters: `mode` (`outline`, the default, or `map`), `scope` and `after` (refs from an earlier read), and `find` (a case-insensitive text filter). The description names the column by the product's own Chinese name and by where it is on the screen, which is what a model finds it by: asked about "the table on the right" with nothing in the prompt naming that phrase, a model reached this column in ten runs out of ten. Directional aliases bought nothing on top of the position and the context's own list of entries, so none are offered. It states the three answers a read can give, so a first call already knows how to continue. This package contributes no system-prompt section for it.

#### Token effect

A fixed description plus four parameter lines, on every request where the tool is visible.

#### KV Cache effect

The description is a constant and never varies within a deployment, so the tool block stays byte-identical across requests and the prefix holds.

### The read result

#### What the model sees

A successful read answers with one text block: a `Page: <title> — the app is at <path>, title "<document title>"` line, extended with the visible breadcrumb and, each on its own line, the name of any dialog the page has open, what the page marks as still loading, and whether it was still changing when the read ran — followed by the listing itself. A whole page too large for the budget answers with the page's map and says so on that first line; a listing cut short ends with the cursor to pass back as `after`. Every other ending is an error naming what to do next: call `content_show`, drop `scope`, read a smaller part of the page or raise `outlineChars`, ask the user to sign in, ask the user to open the console, or retry once. One of them takes two forms, because the right next step depends on what the column already holds: over an empty column the claim timeout keeps the offer that fixes it, and over a column with something in front it withdraws that offer and says so, naming the entry by its own kind word — `the chart "…"` for a chart — because the column's key domain is open and `content_show` helps a chart in front no more than a page. A composition with no projection registry reads no column and takes the first form.

##### The claim timeout over an empty column

```markdown
No open console is showing this session's content column (waited 3s). Call content_show to put a page there, or ask the user to open the console, then retry.
```

##### The claim timeout over a column with an entry in front

```markdown
No open console is showing this session's content column (waited 3s); the page "点位信息" is already in front. Ask the user whether they have the console open on this session, then retry. content_show cannot help here.
```

#### Token effect

Bounded by `outlineChars` — a listing is rendered under that budget, so one read costs at most that much plus the header line. The two answers that keep a read from ever being a blind cut, the map and the cursor, are what the budget buys.

#### KV Cache effect

Append-only. The listing is a fact about the page at that moment; a second read of a changed page is a new result rather than a rewrite of the first.

### The `content_act` offer

#### What the model sees

One tool, `content_act`, offered beside `content_read` wherever the deployment configured `pageAccess`. Two parameters: `steps`, required, each `{action, ref, label, text?, value?, key?}` with `action` one of `click`, `fill`, `select`, `press`, `wait`; and `dialogs`, `cancel` or `accept`, for a native dialog the page opens while the steps run. The description says the label is checked against the page before the browser acts, so the model knows a stale read stops the call rather than acting on the wrong element, and that one call is one approval request, which is the cost model behind putting the steps that belong together in one call.

#### Token effect

One schema, listed on every request for as long as the tool is offered — a description of about 120 words, six parameter lines inside `steps`, and one for `dialogs`.

#### KV Cache effect

Stable: the schema is fixed at load and never varies by session or by what the column holds.

### The result of a set of steps

#### What the model sees

Three sections, always in this order: what ran or which step stopped the call, what the page did on its own while the steps ran, and a whole fresh reading of the page. The third is a `content_read` of the same page at the same budget, so the refs in it are the ones the next call can point at.

##### A call whose steps all ran

```markdown
Done 2/2 on 点位信息: fill "名称" ← "东风"; click "查询" (settled after 0.8s).
Page events during these steps:
  message "查询成功" (shown for 2.1s, gone before the snapshot)
Page now:
1 main
  2 heading "点位信息"
  3 table "点位列表" — 名称, 状态, 操作 · 24 rows · e14
```

##### A call one step stopped

```markdown
Step 2 failed: e5 is now "重置", not "查询" — the page changed; call content_read for current refs. Step 1 ran; later steps were skipped.
Page events during these steps: none.
Page now:
1 main
  2 heading "点位信息"
```

##### The console claimed the call and went quiet

```markdown
The console claimed this call but did not report within 60s; the steps may have run partially or fully. Call content_read before deciding to retry.
```

#### Token effect

Bounded by `outlineChars` for the closing reading, plus one clause per step on the first line, plus at most eight lines of what the page did with each cut to 200 characters. A call that changed the page therefore costs about what a read of it costs, which is the point: the model does not have to read again to see what it did.

#### KV Cache effect

Append-only. Each result is a fact about the page at that moment, so a second call is a new result rather than a rewrite of the first.

### The content-column context

#### What the model sees

One `content:column` block on every request, listing what the column holds newest first — `- "<title>" (<kind>, opened by the user|you)`, the entry in front marked `← in front`, and for a page whose frame has moved a second line naming the address it is at now. It lists `contextEntries` of them (10 by default) and says how many older ones it did not, with every name cut to `contextFieldChars` (120 by default). A column that holds nothing says so in one sentence. The closing line names what to call: `content_show puts a page in front.`, preceded where the deployment offers a reader by `content_read reads the entry in front` and by the rule keeping the model's own handles out of its answers — refs like `e12` are for `content_read`'s `scope` and `after`, and an answer to the user names what the page shows instead. That rule lives here rather than in the tool description because it governs the answer rather than the call: a model choosing the tool has already read the description, while the sentence it writes afterwards is composed against whatever the request carried.

#### Token effect

The block is one header line, one line per listed entry — plus a second line for a page whose frame has moved — a count line when the column holds more entries than `contextEntries` lists, and one closing line, or two where the deployment offers a reader, the second being the ref rule. A session that has shown two pages, one of which routed itself, costs five lines per request: header, two entries, one address, one closing. The cost is stated in lines and characters rather than tokens because a token count is a property of the tokenizer the deployment's provider runs, which this package neither loads nor can predict, while `contextFieldChars` (120 by default) is a bound in characters that always holds.

#### KV Cache effect

A context, not a section: it is materialized after the retained history, so the value changing as the user works never rewrites the cached system-prompt prefix. The block itself changes whenever the column does, which is the point of it.

### The notice a user's page click injects

#### What the model sees

One sentence as an injected context message, once per click: `The user opened the page "<title>" in the content column (内容区); it is in front now.` It arrives on the agent's next pre-step and wakes nothing.

#### Token effect

One short sentence per click, permanently on the conversation.

#### KV Cache effect

Append-only, at the tail of the conversation, so it invalidates nothing already cached.

## Known Limitations and Deferred Work

- **`content/navigated` is required on read, like `content/shown`** — neither event carries an `ignorable` marker, because `Session.append` has no way to set one today; a runtime whose session vocabulary excludes this package refuses the whole log rather than skipping the events.
- **A route change costs one poll interval** — `pushState` fires nothing, so an application that routes and then sits still is noticed on the next poll (default one second) plus the settling window. Lowering `navigationPollMs` buys latency and spends a same-origin property read per frame per interval; the frame's own `history` is deliberately not patched.
- **The navigation watch covers only the frame in front** — a cached, hidden frame that routes itself is not watched, and the move is noticed when that page comes back to the front.
- **A self-rewriting title is a move** — an address here is the path and the document title together, in the poll as much as in the comparison, because an application that renames itself after fetching has moved as far as the model is concerned. A page whose title carries a live counter therefore produces one `content/navigated` per change it holds still through, paced by `navigationPollMs` rather than by the page.
- **The settle wait cannot see a page that paints on a timer** — a document that repaints every second never holds still for the quiet window and every read of it carries the still-changing line. That is the honest answer, not a failure: the budget bounds the wait rather than the page.
- **`aria-busy` is the only busy signal read** — a page that marks nothing loading gets no busy line however long it spins, because no framework's own loading class is known here.
- **`contentPages` has no wire** — it is a host-only fold; a browser that wants where a frame went reads the frame.
- **`content/shown` is required on read** — the event carries no `ignorable` marker, so a runtime whose session vocabulary does not include it refuses the whole log rather than skipping the event. Any build of this repository knows the type; a separately built runtime that excluded this package would not.
- **The on-display rule does not distinguish writers** — [`content-surface`](../content-surface/README.md)'s kind-agnostic prompt rule tells the model to update "something you have already produced and put on display" in place. A page a user opened through the sidebar menu is on display exactly the same way a page the agent chose is, so the rule's wording still reads as if the agent produced it. The `by` field exists to let a future prompt or renderer draw that distinction; the rule's wording is deliberately left unchanged (it is a pinned, measured string — see its own module doc) rather than patched for this one case.
- **The `page` extractor's resolved `by` is not yet rendered** — the browser's page frame draws the same iframe regardless of who showed it. The field is carried through so a later change can show it without another `dataVersion` bump.
- **One directory, one origin** — the route serves a single configured directory, and every page must be a path inside the dsh origin. There is no second application, no external URL, and no way for the agent to name a page the deployment did not configure.
- **The frame still reports nothing of its own** — no `postMessage` protocol and no shared state: what the agent learns about the page it learns by reading it or by acting on it, and what the user does in the frame between those calls reaches nobody. The page's only route back into the harness is the dsh HTTP API, which it reaches on its own.
- **Acting is five actions, and no gestures** — no drag, no scroll, no hover, no file upload, no right-click, and no way to act on anything a read did not number. A page that needs one of those needs a user.
- **A step's target is checked by name, which is not identity** — two rows whose buttons are both called `编辑` are the same name to this check, so a re-render that reordered them passes it. The ref is what names the element and the name is what catches the page having moved under it; neither one alone is an identity, and a page that renumbers and renames together is a page a read has to be taken of again.
- **The dialog stand-ins are the one injection into the frame** — for the length of a call, `confirm`, `alert`, `prompt` and `window.open` are this package's, restored when the call ends. A page that captured its own references to them before the call keeps calling the originals, and a page that opens a dialog outside a call blocks its own frame as it always did.
- **What the page did on its own is a heuristic, and a bounded one** — text is reported as a message when it appeared and went away while the steps ran, at most eight things per call and each cut to 200 characters. An application that redraws a list mid-call spends that budget on its own churn, and a message that appeared and stayed is left to the closing snapshot.
- **A step waits on the frame's own document alone** — the settle wait and a `wait` step read the frame's document, so an application that draws into a nested same-origin frame is read by the closing snapshot and not waited for.
- **`dialogs: accept` is spent by the call that was asked about** — the record is consumed on use, so a retry of the same call cancels the page's dialog instead of confirming it, and asks the user again.
- **The `content` projection has no in-tree consumer** — the column reads the entry stream instead, and `content` remains only as the resolved current-page value (`shown`/`default`/`empty`/`missing`) for anything else reading the wire. It is the one place `defaultPage` still shows up.
- **The frame cache is per browser tab and unbounded in time** — `cacheSize` bounds how many frames stay alive, not how long. A tab left open keeps its cached documents running, including whatever polling or sockets they hold.
- **The settings route assumes an HTTP carrier** — the browser half fetches `/content-frame/settings` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way the iframe's own route would.
- **No sandboxed profile for untrusted content** — see the trust boundary above. Hosting content that must not carry the shell's authority is a separate plugin that this one does not provide a flag for.
- **Only a `label` names a field the page tied nothing to** — a page that draws the words in a `div` or a `span` leaves the field unnamed rather than risk naming it after a notice drawn beside it, and a `label` running longer than a label does keeps its own row instead. A field taking its name from a `label` drawn inside a longer run keeps that run as a row too, so those words reach the reader twice.
- **The star is read on the labels the page ties to a field and on the one drawn in front of it** — a field the page names with `aria-label` and stars on a `label` it ties to nothing is not reported as required.
- **The icon rule is a markup heuristic, and everything it misses it misses silently** — an icon font that never writes the word `icon` reaches the read as nothing, a drawing naming itself in neither a class, a symbol, nor a title is read as decoration, and an icon drawn outside a cell, a toolbar, or a list is read as decoration wherever its name comes from. All three are the price of a rule the page's own markup, rather than a specification, has to earn.
- **A table drawn over another it does not repeat row for row is dropped** — the pieces of one table are recognized by carrying the same rows, and a table drawn over another without them is read as one thing the page drew twice, so its rows reach the model nowhere. A pinned piece drawn in a region of its own is not found either: two tables in two regions are two tables.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, and the model-visible text is pinned verbatim in unit tests; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
- **The read routes carry no Host fence** — like the shell's own `/api`, they refuse a request a browser labelled `sec-fetch-site: cross-site` and require `application/json`, but neither check survives DNS rebinding, and the webserver has no Host allow-list of its own (`trustedHosts` guards `/api` alone). What stands in its place is the call id: an attacker who reaches the routes can neither claim a read nor answer one without knowing an id the host minted and published only into that session's own projection stream, and a claim or report for an unknown id changes nothing. That id's unguessability is the LLM provider's property, not this package's — DeepSeek mints `call_00_` plus twenty-four alphanumeric characters whose last four are digits, and a code-mode subcall is that same id plus `:code:<n>` — and nothing here checks the format or strengthens it, so a provider numbering its calls `call_1`, `call_2` would leave both routes open to any page that can reach this host. A deployment exposing the harness to an untrusted network needs a fence at its reverse proxy, as it does for every other route.
- **Which entry is "in front" is the page seat's answer, not the log's** — which entry the user picked is a viewing decision the column keeps in component state, so a read reaching a session whose column holds several other kinds says the entry in front is not a page without naming which one it is.
- **A read carries structure, never data** — there is no mode that returns a table's contents, and none is planned here: a listing is what the model needs to point at the page, and the data behind it belongs to whatever produced it.
- **jsdom cannot stand in for the frame** — it has no layout and never loads a frame pointed at a real route, so the package's own suites read hand-mounted documents and the real path is covered by the browser lane alone.
- **The empty-command-row CSS collapse is a DOM-shape coupling, not a contract** — it keys off `dsh-client-ui-conversation`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper, neither of which this package owns or that package promises to keep. A future change to either shape silently un-collapses the row (it reappears with its 16px gap) rather than failing loud; the `server-sidebar.e2e.ts` scenario asserting the row stays invisible is this coupling's only tripwire.
