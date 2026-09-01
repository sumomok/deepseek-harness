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

**Absent is off, and absent is the default.** Without the block there is no tool, no route, no pending projection, no `pageAccess` field in the settings document, and no reader in the browser — a deployment that only shows pages does not pay for a capability it did not ask for. Present with an empty object takes every default. The four fields — `claimTimeoutMs`, `readTimeoutMs`, `pinMs`, `outlineChars` — are documented on the `Config` type; `outlineChars` is the one that decides what a read costs in context, because it is the character budget the listing is rendered under. It has a floor of 1000, refused at load: a listing's first row is rendered however long it is, and below that floor an ordinary table's first row is already past what the report route takes.

### The channel

A host cannot address a browser, so the call travels the other way. The tool body writes nothing: it registers a wait and publishes the call in the session's own `contentAccess` projection, which every connected browser already receives. The page seat showing that session claims the call on `POST /content-frame/claim`, walks the frame's document, and posts the listing to `POST /content-frame/report`. Only the claiming tab's report is taken, which is why the claim is a round trip rather than an announcement.

Two deadlines, because "no console is open" and "the console that answered went quiet" are different facts and the model acts differently on each. A call unclaimed within `claimTimeoutMs` is told no console is showing this session; a claimed call unanswered within `readTimeoutMs` is told to retry once. One session's consecutive reads stick to one tab: the tab that last answered is preferred for `pinMs`, and another tab's claim is held briefly so the preferred one can take it first. Refs name elements of one document, so two consoles answering alternate reads would hand the model refs that name nothing.

Neither deadline is spent on a single attempt. A claim that never lands — a dropped request, a moment offline — is bid again at a fixed interval until the claim window is out, and a listing whose first post never lands is posted once more: one dropped request must not be what tells the model there is no console, with the console in front of the user the whole time. Within the report deadline the seat spends at most half on a page that is still loading, because the host started counting the moment it granted the claim and the walk and the trip back need the rest.

The reading half lives in the page seat because that is the only placement holding the frame elements. Visibility and geometry are asked of each element's own window rather than the top one — a frame's layout belongs to that frame — and a tab that is not visible claims nothing, because the read is defined as the page in front of the user.

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

One tool, `content_read`, offered only where the deployment configured `pageAccess`. Four optional parameters: `mode` (`outline`, the default, or `map`), `scope` and `after` (refs from an earlier read), and `find` (a case-insensitive text filter). The description names the column in the user's own words — 内容区, 中间, 右边 — because that is how a user points at it, and states the three answers a read can give, so a first call already knows how to continue. This package contributes no system-prompt section for it.

#### Token effect

A fixed description plus four parameter lines, on every request where the tool is visible.

#### KV Cache effect

The description is a constant and never varies within a deployment, so the tool block stays byte-identical across requests and the prefix holds.

### The read result

#### What the model sees

A successful read answers with one text block: a `Page: <title> — the app is at <path>, title "<document title>"` line, extended with the visible breadcrumb and, on its own line, the name of any dialog the page has open, followed by the listing itself. A whole page too large for the budget answers with the page's map and says so on that first line; a listing cut short ends with the cursor to pass back as `after`. Every other ending is an error naming what to do next: call `content_show`, drop `scope`, ask the user to sign in, ask the user to open the console, or retry once.

#### Token effect

Bounded by `outlineChars` — a listing is rendered under that budget, so one read costs at most that much plus the header line. The two answers that keep a read from ever being a blind cut, the map and the cursor, are what the budget buys.

#### KV Cache effect

Append-only. The listing is a fact about the page at that moment; a second read of a changed page is a new result rather than a rewrite of the first.

## Known Limitations and Deferred Work

- **`content/shown` is required on read** — the event carries no `ignorable` marker, so a runtime whose session vocabulary does not include it refuses the whole log rather than skipping the event. Any build of this repository knows the type; a separately built runtime that excluded this package would not.
- **The on-display rule does not distinguish writers** — [`content-surface`](../content-surface/README.md)'s kind-agnostic prompt rule tells the model to update "something you have already produced and put on display" in place. A page a user opened through the sidebar menu is on display exactly the same way a page the agent chose is, so the rule's wording still reads as if the agent produced it. The `by` field exists to let a future prompt or renderer draw that distinction; the rule's wording is deliberately left unchanged (it is a pinned, measured string — see its own module doc) rather than patched for this one case.
- **The `page` extractor's resolved `by` is not yet rendered** — the browser's page frame draws the same iframe regardless of who showed it. The field is carried through so a later change can show it without another `dataVersion` bump.
- **One directory, one origin** — the route serves a single configured directory, and every page must be a path inside the dsh origin. There is no second application, no external URL, and no way for the agent to name a page the deployment did not configure.
- **No channel between the frame and the shell** — no `postMessage` protocol, no shared state, and no way for the hosted page to report back what the user did in it. The agent can put a page in front of the user; it cannot learn what happened next except by being told. The page's only route back into the harness is the dsh HTTP API, which it reaches on its own.
- **The `content` projection has no in-tree consumer** — the column reads the entry stream instead, and `content` remains only as the resolved current-page value (`shown`/`default`/`empty`/`missing`) for anything else reading the wire. It is the one place `defaultPage` still shows up.
- **The frame cache is per browser tab and unbounded in time** — `cacheSize` bounds how many frames stay alive, not how long. A tab left open keeps its cached documents running, including whatever polling or sockets they hold.
- **The settings route assumes an HTTP carrier** — the browser half fetches `/content-frame/settings` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way the iframe's own route would.
- **No sandboxed profile for untrusted content** — see the trust boundary above. Hosting content that must not carry the shell's authority is a separate plugin that this one does not provide a flag for.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, and the model-visible text is pinned verbatim in unit tests; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
- **The read routes carry no Host fence** — like the shell's own `/api`, they refuse a request a browser labelled `sec-fetch-site: cross-site` and require `application/json`, but neither check survives DNS rebinding, and the webserver has no Host allow-list of its own (`trustedHosts` guards `/api` alone). What stands in its place is the call id: an attacker who reaches the routes can neither claim a read nor answer one without knowing an id the host minted and published only into that session's own projection stream, and a claim or report for an unknown id changes nothing. That id's unguessability is the LLM provider's property, not this package's — DeepSeek mints `call_00_` plus twenty-four alphanumeric characters whose last four are digits, and a code-mode subcall is that same id plus `:code:<n>` — and nothing here checks the format or strengthens it, so a provider numbering its calls `call_1`, `call_2` would leave both routes open to any page that can reach this host. A deployment exposing the harness to an untrusted network needs a fence at its reverse proxy, as it does for every other route.
- **Which entry is "in front" is the page seat's answer, not the log's** — which entry the user picked is a viewing decision the column keeps in component state, so a read reaching a session whose column holds several other kinds says the entry in front is not a page without naming which one it is.
- **A read carries structure, never data** — there is no mode that returns a table's contents, and none is planned here: a listing is what the model needs to point at the page, and the data behind it belongs to whatever produced it.
- **jsdom cannot stand in for the frame** — it has no layout and never loads a frame pointed at a real route, so the package's own suites read hand-mounted documents and the real path is covered by the browser lane alone.
- **The empty-command-row CSS collapse is a DOM-shape coupling, not a contract** — it keys off `dsh-client-ui-conversation`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper, neither of which this package owns or that package promises to keep. A future change to either shape silently un-collapses the row (it reappears with its 16px gap) rather than failing loud; the `server-sidebar.e2e.ts` scenario asserting the row stays invisible is this coupling's only tripwire.
