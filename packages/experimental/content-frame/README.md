---
description: "The agent's handle on the service-line shell's content column: a named webserver route over one directory, the content_show tool over its configured pages, the projection recording what each column shows, and the browser half keeping one live frame per session; for deployments publishing their own pages and the maintainers of that path."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-content-frame

English | [中文](README.zh.md)

## Summary

The `page` kind of the service-line shell's content column, and the two ways to control it: a directory of static files on the host, served under one dsh route, shown in an iframe that fills the column — with the agent choosing which of the deployment's pages is in it through the `content_show` tool, and a user choosing directly through the sidebar's page-navigation menu (`@deepseek-ai/dsh-experimental-server-sidebar`), which executes the `show-content-page` command. The application inside is written and deployed by whoever runs the harness; this package neither builds it nor knows what framework it uses.

Seven pieces, one decision each. The node half serves the configured directory under `/content-app`. `content_show` offers the deployment's page list to the model and appends `content/shown` when it chooses. `show-content-page` offers the same page list to a command-executing UI and appends the same event when a user chooses. The `page` extractor turns each shown id into an entry of [`content-surface`](../content-surface/README.md)'s stream, resolved against the page list running now. The `content` projection resolves the last recorded id the same way, for a consumer that wants the column's current page rather than its history. The browser half claims the `page` key of the column's kind slot and keeps one live frame per (session, page) pair. Where the deployment turns it on, `content_read` lets the agent read the page in that frame as a numbered structure, three markup reads let it read that page as it was written, and — where an attachment store is mounted — `content_read_image` answers with one element's own rendered pixels.

## Table of Contents

- [Trust boundary](#trust-boundary)
- [Serving the application](#serving-the-application)
- [Who put a page on display](#who-put-a-page-on-display)
- [Pages the agent may show](#pages-the-agent-may-show)
- [One live frame per session and page](#one-live-frame-per-session-and-page)
- [Reading the page the agent put there](#reading-the-page-the-agent-put-there)
- [Reading the page as it was written](#reading-the-page-as-it-was-written)
- [Reading one picture on the page](#reading-one-picture-on-the-page)
- [Acting on the page the user is looking at](#acting-on-the-page-the-user-is-looking-at)
- [Reading the page in the frame](#reading-the-page-in-the-frame)
- [What the agent knows about the column](#what-the-agent-knows-about-the-column)
- [Reading a page that has not finished drawing itself](#reading-a-page-that-has-not-finished-drawing-itself)
- [Hiding the `show-content-page` command from the chat transcript](#hiding-the-show-content-page-command-from-the-chat-transcript)
- [Composition](#composition)
- [What the tools say and what they never say](#the-copy-rule)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="trust-boundary"></a>
## Trust boundary

**The hosted pages run with the shell's own authority.** They are served from the dsh origin and the iframe carries no `sandbox` attribute, which makes each document same-origin with the shell: it can call the dsh HTTP API — sessions, tools, settings, everything the browser can reach — without any further permission. `root` must therefore name a directory whose contents are trusted exactly as much as the harness itself.

That is the point of the design rather than an oversight. A first-party application in the content column is expected to talk to the harness, and an opaque origin cannot: the API's Origin check rejects `null`, so a `sandbox` without `allow-same-origin` would leave the frame unable to do anything, while a `sandbox` with it removes nothing. Hosting content that should **not** have that authority — agent-generated pages, third-party bundles, anything a user drops in — needs a separate, sandboxed plugin, not a flag here.

<a id="serving-the-application"></a>
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

<a id="who-put-a-page-on-display"></a>
## Who put a page on display

`content/shown` carries a `by: 'agent' | 'user'` field: `content_show` (the model's tool) writes `'agent'`, and `show-content-page` (the sidebar menu's command) writes `'user'`. A log written before this field existed carries neither, and every reader defaults that case to `'agent'` — the tool was the only writer then. The two writers append the identical event under the identical type, so a page shown by a user click and a page shown by the model occupy the same one entry in `content-surface`'s stream (deduplicated by page id) and the same `content` projection value; nothing about which existing kind or projection is used changes with the writer.

The `content` projection deliberately drops `by` — it answers "what page is on display," which needs no writer distinction — while the `page` extractor keeps it in its stored and resolved payload, for a renderer that wants to show the distinction later; today's frame renderer does not (see Known Limitations).

<a id="pages-the-agent-may-show"></a>
## Pages the agent may show

`pages` is the deployment's whole vocabulary for the column, and at least one entry is required — `content_show` exists to choose among them. Each page declares an `id` the agent passes, a `title` the user reads, a `description` written in the agent's terms (it becomes the catalogue line in the tool description), and a same-origin `url`. A URL that names a scheme or a host fails the row at load: the frame carries the shell's authority, so it may only address the dsh origin.

`defaultPage` names the page the `content` projection reports before the agent has chosen anything and after it clears the column. **The column itself does not show it** — it lists what a session produced, and a default page is not something any session produced, so a session that has shown nothing gets the column's empty-state notice. `id` may not be `none`, which the tool reserves for clearing.

`homePage` names the page `@deepseek-ai/dsh-experimental-server-sidebar`'s workbench shows automatically the first time a session lands on a blank draft. Unlike `defaultPage`, this is not a projection value read passively — the sidebar issues an actual `/show-content-page` invocation, so the column really does show the page and the usual `content/shown` log record follows. Read this package's `Config` type for the exact difference; the sidebar package is this field's only consumer.

<a id="one-live-frame-per-session-and-page"></a>
## One live frame per session and page

The column's kind slot is `root`-scoped and the column keeps this seat mounted even while another kind is on display, so the browser half keeps every cached frame mounted at once with all but the current one hidden. A page the user returns to therefore looks exactly as it was left — scroll position, form state, whatever the document holds — because the element was never destroyed, across a switch to another page, to a chart, or to another session. `cacheSize` bounds how many survive, counted over (session, page) pairs; past it the least recently shown one is dropped and reloads when it comes back. The frame on display is never the one dropped.

<a id="reading-the-page-the-agent-put-there"></a>
## Reading the page the agent put there

`pageAccess` gives the agent `content_read`: one call answers with the page the user is looking at as a numbered structure — containers, controls, headings and text, each control carrying a ref like `e12` that a later call can point at. Structure reaches the model and data does not: a table reports its header, its size and one sample row, and lists rows only when a read names that table by ref or matches one by its text.

**A password box's value is the one thing no tool of this package prints.** Every read reports that the box is there and none of them reports what it holds: the listing prints `= (hidden)` where a value would go, `content_read_attrs` answers `(password withheld)` for `value`, and a tree line and a whole-text read answer the same for the text a `textarea` declaring a password in `autocomplete` keeps its value in. A `content_act` `fill` into one is reported as having filled it and never with what. A control is a password control by its `type` or by that attribute, on any of the three tags HTML gives an autofill field name to, and that one rule is the whole of what this package withholds for a credential — a page showing a sign-in form is read and acted on like any other page.

**Absent is off, and absent is the default.** Without the block there are none of the six tools, no route, no pending projection, no `pageAccess` field in the settings document, and no reader in the browser — a deployment that only shows pages does not pay for a capability it did not ask for. Present with an empty object takes every default. The eight fields — `claimTimeoutMs`, `readTimeoutMs`, `pinMs`, `settleQuietMs`, `outlineChars`, `actTimeoutMs`, `maxSteps`, `settleMaxMs` — are documented on the `Config` type; `outlineChars` is the one that decides what a read costs in context, because it is the character budget the listing is rendered under. It has a floor of 1000, refused at load: a listing's first row is rendered however long it is, and below that floor an ordinary table's first row is already past what the report route takes. `readTimeoutMs` has a floor of 8, refused at load for a reason of the same kind: a picture read gives the export an eighth of it rounded to milliseconds, and below that floor that budget is zero or one millisecond, so every picture would be refused as one the console did not draw in time. Three have ceilings instead of floors, all refused at load: `settleQuietMs` must fit inside the settle share of `readTimeoutMs`, because a quiet window the budget cannot hold would make every read report a page that never settled; `settleMaxMs` must be at least `settleQuietMs`, and `maxSteps` of it must come to less than three quarters of `actTimeoutMs` — the steps' own share of that deadline — because a deployment whose steps could each settle to the ceiling is one where a call spends its whole deadline settling and never reaches its last step; and `maxSteps` is capped at 100, which is what keeps a report of steps inside the envelope the report route allows.

<a id="reading-the-page-as-it-was-written"></a>
## Reading the page as it was written

The same block gives the agent three more reads, and all three answer about markup rather than about meaning: `content_read_dom` prints one subtree as an indented tree — a line per element with its tag, its `#id`, its class tokens as `{class: …}`, a ref of its own and the start of the text it holds directly; `content_read_attrs` prints one element's every attribute, name and value as the page wrote them; and `content_read_dom_content` prints one element's whole visible text, line-broken where the page breaks lines and never cut.

**They exist for the row `content_read` can name nothing.** A component library's row commands carry no role, no name, no title and no pointer cursor, so the listing prints that column empty and the user sees two icons in it. `content_read` is still the read a page starts from — it is the page as HTML and ARIA describe it, an order of magnitude smaller than the markup under it, and the only place refs come from — but no description says so, because [every description here describes only its own tool](#the-copy-rule). What holds a whole page of markup back is `content_read_dom`'s required `scope`, which makes a prior read the only way to call it at all.

**Nothing is interpreted, ever.** A tag, an id, a class token and an attribute value are printed as the document spells them, in the order the document holds them. What `op-a` or `el-icon-edit` means is for a skill about that application to say; this package prints and never guesses. The class tokens a tree line prints are the same `elementMark` the listing prints for an unnamed row, so a `content_act` step naming a row a tree found carries the string the tree showed and the seat compares the two character for character.

**What each one bounds, and how.** The tree is rendered under `outlineChars` exactly as a listing is and returns a cursor for the rest — pass it back as `after` with the same `scope`. The other two are never cut: an element's attributes and an element's text are answered whole or not at all, and an answer past what the report route carries is refused with its size in characters and the budget it ran past. Every element a tree prints keeps a ref, so a `content_read_dom` of a row is also how the model reaches an element that no listing gave it a handle on.

Reads only, and the same conditions as the listing: the same claim and report routes, the same pending projection, the same page in front, and the same withholding of what a password control holds.

<a id="reading-one-picture-on-the-page"></a>
## Reading one picture on the page

The same block gives the agent `content_read_image`, and it answers the question the other four cannot: what a page **draws**. A QR code, a captcha, a chart painted into a canvas, an icon drawn as a shape — the listing prints a row for it at best, the markup prints `<img src="/pairing?ts=…">`, and neither says what is in it. One call takes a `ref` from an earlier read of this page and returns that element's own rendered pixels as an image the model looks at, beside one line of facts about what came out.

**Four tags, and what each exports.** An `img` and a `canvas` export their own stored raster — `naturalWidth × naturalHeight` and the backing store's `width × height`. A `picture` exports the `img` it renders through, under the wrapper's own tag. An `svg` has no stored raster, so its layout box is rasterized. Anything else is refused by its tag.

**A very small picture is enlarged, as far as that costs nothing.** The provider prices an image by the grid it projects onto, and it scales anything under its own floor — `MIN_PIXELS`, 384 × 384 total pixels, in `packages/llm/llm-deepseek/src/image-tokens.ts` — up to exactly that area first. Two pictures of one ratio whose areas are both at or under the floor therefore land on the same grid and cost the same tokens, and a picture past it costs by its pixels. A square prices at 117 tokens at or under the floor, 201 at twice its area and 349 at the whole pixel budget, against the provider's 384-token cap; another ratio prices differently at each, because the price is the grid's rather than the area's. So the floor's area is what an export is enlarged toward and never past. A vector is rasterized to it, at whatever ratio its layout box has. A bitmap is drawn at the largest whole multiple of itself that still fits inside it — twelve times over for a 32 × 32 logo, three for a 100 × 100 icon, and once, unchanged, for anything past a quarter of the floor — with smoothing off, so every stored pixel becomes the same square block and no edge lands between two of them. That multiple is the whole of the enlargement: the floor's area is a fraction of the request's own pixel budget — 640,000, `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` — so nothing scales an enlarged raster afterwards. The budget still holds a picture that arrives past it, by the same geometry the attachment layer projects a request image with, and those are scaled down with smoothing on.

**PNG, and 2 MiB.** The export asks for PNG because the answer has to be lossless (a QR code loses nothing), because an icon's alpha channel survives it, and because it is the format a canvas falls back to for any type an engine does not support — so asking for it is the one request no engine answers with something else. What the model finally receives is the attachment layer's own re-encoding for the route, so the format here costs bytes on one same-origin post and on disk, and no fidelity. An export past 2 MiB is refused with its size rather than re-encoded at a lower quality; the bound is twice the provider's own per-image request budget, which is the headroom losslessness needs.

**The pixels travel their own route.** A seat posts them to `POST /content-frame/image` as base64 inside JSON — the same same-site, `application/json` fence the other two routes keep — and that route has a byte bound of its own, computed from the bytes one export may carry rather than from the deployment's character budget. Carrying an image through the report route would have raised the bound on every text read with it. The host commits the bytes to `ctx.attachments` **before** the call settles, so the reference the session log records names an object that is already on disk.

**Two gates before anything is exported.** The `ref` is checked for shape, and then the session's own route is put through `access/model-switch.ts`. The second is a gate rather than a graceful degrade because its failure is not recoverable: a picture reaches the model through a stored attachment, the store keeps what it is given for good, and a text-only route would drop the image block from the request after the pixels were already on disk. It has three endings. A route that declares image input passes. A route that does not, in a deployment where some other route does, puts one card in front of the user asking whether to change the session's model — and where they choose one, the session is moved to it through `sessionController.selectModel`, the route it moved to is put through the gate's own criterion again, and the read runs. Every other answer refuses the call and changes nothing. The card is asked here, before the wait opens and before a browser is asked to draw, because a change the user declines must leave no stored picture behind; a user is asked once per session, because a refused read is one the model may retry. Only what the card decided counts as an answer: a card the user closed, and one raised for a caller that can never reach a human, are asked no more, while a card no console was open to answer — or whose channel broke while it stood — leaves no mark and the next read asks again.

The change lasts: the session's remaining turns run on the chosen model until the user changes it back, and `selectModel` also saves the choice as the deployment's default, so a session opened later starts there too. The card says the first of those in one sentence and not the second.

**The route the gate decides on.** Three tiers: a model selection the console made that no request has consumed yet, then the route the session's last request header logged, then the options the agent was created with. The first two, and their order, are `selectionFor`'s own (`packages/api/session-controller/src/agent.ts`); the third is not — the controller falls back to the deployment default, which this package's Client-face program cannot read, and nothing reaches that tier inside a tool execution because a tool call implies a request and a request logs a header. The first tier is why a user who changes the model in the picker and asks again is not refused, and why the second of two parallel reads passes without a second card.

**Which models the card lists.** Every model of every registered provider whose catalogue declares `image` input, in provider registration and adapter-preferred order — read through `ctx.llm`, because the model catalog the console's picker renders carries no modality. `inputModalities` is the only criterion and an absent one is a negative answer. A provider whose catalogue cannot be read is left out and the rest of the card stands. Where no configured model declares image input the card is not shown at all and the call is refused saying so, and a composition with nobody to ask refuses before any catalogue is read.

A catalogue is what a deployment claims, and `selectModel` checks that the chosen route resolves rather than what it accepts, so the route the session moved to is resolved and read for `image` before the read runs. A deployment whose catalogue and whose resolved route disagree ends in the same refusal a text-only route earns, with the change made and no picture exported.

**What the model is told never mentions the card.** A declined change, a card the user closed, and a composition with nobody to ask are all answered with the refusal the read already had — the session's model does not declare image input, which stays true and gives the model no handle to raise the card again.

**What the card says.** The one surface of this package a person reads rather than a model, in the console's question composer, as host-side Chinese literals:

```
内容区的图
当前模型看不了图片，换一个能看图的模型吗？
换过之后，这次对话接下来都用你选的那个模型；你随时可以自己换回来。

  1. DeepSeek：DeepSeek-V4-Flash-Vision-Exp
  2. 先不换  这次就不看这张图了
```

One option per model, labelled `厂商：模型` and carrying its model id as well wherever two options would otherwise read the same; one option that changes nothing, last. Single-select, and no presentation intent, so the console renders its generic option list.

**No store, no tool.** The read is registered inside `ctx.inject(['tools', 'attachments'], …)`, so a deployment with no attachment store is offered the five text tools and neither this one nor its route. The shipped `base` bundle mounts one.

<a id="acting-on-the-page-the-user-is-looking-at"></a>
## Acting on the page the user is looking at

The same block gives the agent `content_act`: one call carries up to `maxSteps` steps — `click`, `fill`, `select`, `press`, `wait` — run in order against the page in front of the user and stopping at the first failure. Every step but `wait` names its element twice, by the `ref` a read returned and by the `label` that read printed — or, where that read printed no name, by the `mark` it printed in the name's place — and the browser checks what it was given before it acts, computing it the same way the listing printed it — one naming function, called once per row by the read and once per step by the browser, because a name computed two ways would refuse every step naming an element the two disagree about. A page that re-rendered its table between the read and the call has the same refs pointing at different rows, and the check is what stops the call rather than pressing whatever now sits there. Four more endings stop a step — an element the page no longer has, one it no longer shows, one behind a dialog the page has put in front of the user, and one the page has switched off.

A step runs in the document its element lives in, which is not always the frame's own: the reader walks into same-origin frames the page holds, so its refs can name elements there, and the events, the value setter, the dialog check and the settle wait all follow the element. The events are the page's own. A click is the whole pointer sequence a user produces, because a framework listening for `mousedown` alone never sees a bare `click`; a fill goes through the prototype's value setter, because React and Vue both track the value they last wrote and an assigned `el.value` is a change they undo on the next render; a key is three events with no form submitted behind them, because what Enter means is the page's decision. A `select` is either the platform's own `<select>` or the two clicks a drawn picker takes. Between steps the page is given `settleQuietMs` to go quiet, bounded per step by `settleMaxMs` and again by the call's own deadline: the steps get three quarters of `actTimeoutMs`, and a step that would start past that point fails with the rest reported as never run, because the closing read and the trip back with it need the quarter that is left.

**One call is one approval request.** A `tools/pre-execute` listener escalates every call of this tool to a request composed from the arguments and nothing else: nothing has reached a browser when it is written, so it names the column's front entry the way the user sees it rather than a page title the host has not got. That is the other reason `label` is required on every step, and `mark` with it wherever the label is empty — the user is told what will be clicked and filled, a row the read named nothing reaches them as the mark it carries rather than as 「」, and the only place either can come from is the call itself. The listener delegates first, so a policy that would deny the call still denies it; a deployment composing no approval service runs no steps at all, which is the kernel's own degrade for a call that asks.

**The approval is against the entry that was in front.** A call registers its wait only once the user has answered, so the host records what the column had in front at that moment and hands it to the claiming console with the claim. A console that finds another page there runs nothing and says which page is in front now and which one the steps were approved for: the switcher strip is one click, and a user who moved to another page while deciding did not agree to these steps on that page. A column that has since gone empty or moved to another kind is answered by the ordinary refusals, which say more about what to do next.

**What the browser did on the page's own account comes back with the answer.** For the length of the call — and no longer — the seat listens for route changes and stands in for `confirm`/`alert`/`prompt` and `window.open`: the first three because they block the frame's event loop until something answers and the seat is that something, the last because a window opened behind the console is one nobody will look at. Both stand-ins are put back when the call ends, including where a step threw. `dialogs` says how a native dialog is answered — `cancel` by default; `accept` is refused unless the approval request the user read said the page's own confirmation would be confirmed too, which no standing allowance and no policy that never asks can produce.

What the page itself draws in answer to a step is not watched for: a toast, a banner, a list redrawn underneath are what the closing read is for, and telling one of them from a framework's own redraw meant guessing. The answer is three sections every time, in the same order: what ran, what the page did on its own, and a whole fresh reading of the page at the deployment's own budget. The last one is what makes a following call possible without reading again, since the refs it names are current.

### The channel

A host cannot address a browser, so the call travels the other way. Both tools share it. The tool body writes nothing: it registers a wait and publishes the call in the session's own `contentAccess` projection, which every connected browser already receives. The page seat showing that session claims the call on `POST /content-frame/claim`, does the work — walking the frame's document, or running the steps against it — and posts the answer to `POST /content-frame/report`. Only the claiming tab's report is taken, which is why the claim is a round trip rather than an announcement, and it is also why two consoles open on one session run one copy of a set of steps rather than two. What differs between the two tools is the document posted back, discriminated by its own status; the tool that opened the wait is what decides whether the document it was handed answers its own call.

Two deadlines, because "no console is open" and "the console that answered went quiet" are different facts and the model acts differently on each. A call unclaimed within `claimTimeoutMs` is told no console is showing this session — and, for a set of steps, that nothing was done; a claimed read unanswered within `readTimeoutMs` is told the console never answered, while a claimed set of steps unanswered within `actTimeoutMs` is told the steps may have run partially or fully, because that is the one ending where nothing on this side knows what happened. One session's consecutive reads stick to one tab: the tab that last answered is preferred for `pinMs`, and another tab's claim is held briefly so the preferred one can take it first. Refs name elements of one document, so two consoles answering alternate reads would hand the model refs that name nothing.

Neither deadline is spent on a single attempt. A claim the host does not know yet is bid again for as long as the call is on the session's pending list, at an interval that doubles from 200ms to one second — the seat's own bidding is bounded by the call still waiting rather than by either deadline, and by a ten-minute ceiling past which it lets go for good: a host that stopped mid-write leaves a call opened and never settled, and no approval a person means to answer is still open by then. That is what an approval needs: `content_act` registers its wait only after a person has answered its request, so every claim before that is answered "unknown", and a seat that gave up at the host's claim window would stop bidding while the user is still reading. A claim that never lands — a dropped request, a moment offline — is bid again the same way, and a listing whose first post never lands is posted once more: one dropped request must not be what tells the model there is no console, with the console in front of the user the whole time. A call this seat gave up on — a refused bid, a claim another tab held, the ceiling, a pending list that blipped empty under it — is forgotten rather than remembered as answered, because it is still open on the host: the next projection frame carrying it is one this seat bids for again. Within the report deadline the seat spends at most half on a page that is still loading, because the host started counting the moment it granted the claim and the walk and the trip back need the rest.

The reading half lives in the page seat because that is the only placement holding the frame elements. Visibility and geometry are asked of each element's own window rather than the top one — a frame's layout belongs to that frame — and a tab that is not visible claims nothing, because the read is defined as the page in front of the user. What such a tab does not stop doing is forgetting the calls it gave up on; a hidden seat that skipped that would leave the call it lost unclaimable for the rest of its life.

<a id="reading-the-page-in-the-frame"></a>
## Reading the page in the frame

`src/client/access/` reads the document in the frame as numbered structure — the regions, the controls, and the shape of each table — for a model that cannot see it. The rules it is written by, and what each of them gives up, are recorded in [the reading Agent Note](../../../.agents/notes/implemented/feature/2026-09-02-content-snapshot-engine.md). Nothing in it is keyed to a class name, a component library, or a naming habit: what a page states in HTML and ARIA is what it reads, and a widget no specification names — the strip that pages a table, the trail saying where the user is — prints as the run of text the page drew it as.

### What a console table reads as

- **Every table the page wrote reads as a table of its own.** A component library pins a column by drawing the whole table a second time over the top of itself, and it freezes a header by drawing it as a table above the body, so the page holds several tables where the user sees one. Each of them is read and printed as it stands: nothing is merged into a table the document does not have, and nothing is dropped as a copy of another. What the user sees as one table therefore reaches the model as the tables the page built it out of, each with the columns that piece draws.
- **A table counts the rows it holds.** `e30 table 20 rows × 21 cols` is the twenty rows the page has drawn, which for a table drawn a page at a time is the page on display. What the strip beside it says — `共 89 条` — prints as the run of text it is, where the page draws it, and how many rows there are in total is a thing to read off those words rather than a thing this reader states.
- **A cell offers the things a page draws in it to act on.** A click target the page marks with a pointer cursor is named `clickable` and given a ref inside a cell exactly as it is anywhere else. A row's commands drawn as neither a role nor a cursor — a component library's `<i class="el-icon-edit">` — are in nothing a specification defines, and the cell reads as the empty column the document says it is.

### What a control the page names nowhere reads as

- **The row carries the element's class tokens where its name would go.** `e17 clickable {class: el-tooltip operation-modify el-icon-edit}` — every token the element carries, in the order it carries them, and nothing at all where the element carries no class. Nothing is cut: the string is also the row's mark, which a step carries back and the seat compares token for token, so a shortened one would match nothing. It is printed for the things a page offers to act on and names nowhere — a click target, a button, a link, a box to fill — and for nothing else: a heading or a region says what it is in its role.
- **Nothing is read out of them.** The row is still named nothing: a step naming it passes `label: ""` and that same token string as `mark`, and the seat recomputes both before it acts — the page names the row nothing still, and marks it the same way still. The mark is the tokens and nothing around them: for `e7 clickable {class: row-action danger}` a step carries `ref: "e7"`, `label: ""`, `mark: "row-action danger"`, and a mark holding a brace or the `class:` the listing prints in front of the tokens is refused with that example, because a class token can hold neither and the whole printed row was copied instead. What `el-icon-edit` means is for a skill about that application to say, and this package never guesses.

### What a console form reads as

- **A field is named by the `label` drawn in front of it.** A form that ties no label to its field is named by the last `label` drawn before it, inside the smallest element holding both, as far out as the region the field stands in; that label then prints once, as the field's name, whatever it says and however long it runs. Anything else the reader can act on between the two ends the search, and any other run of the page — a notice, a heading, a caption — names nothing and keeps its own row.
- **A field the page asks for says so.** `(required)` follows a field the page marks with `required` or `aria-required`, and nothing else. A form that says it another way — the star a stylesheet draws in front of a label — says it on the screen and in no attribute, and which fields those are is a thing to know about the form rather than a thing to read out of the document.
- **A picker drawn in two halves is one field.** A box the reader cannot type into says `(readonly)`, and the nameless arrow the page draws inside the same element to open what the field offers prints on the field's row as `[e4 opens]` rather than as a row of its own.

<a id="what-the-agent-knows-about-the-column"></a>
## What the agent knows about the column

The column is drawn by the browser, so nothing in it reaches the model unless this package puts it there. Three facts do, by three different routes, each chosen for how often it changes.

**A page the user opened is announced once, in the conversation.** `show-content-page` injects one sentence — `The user opened the page "<title>" in the content column (内容区); it is in front now.` — as a plugin-sourced `user/message`, after the `content/shown` append, so the log carries the fact before the sentence about it. `inject` queues it for the next pre-step without waking the driver: opening a page is not a question, and an idle agent stays idle until the user says something. It is durable from the moment it is queued — the inbox splice carrying it is a session event of its own — and becomes a `user/message` when a driver claims it. `content_show` injects nothing — the agent already knows what it did.

**The application's own routing is a session event.** The browser half watches the frame in front for `load`, `hashchange` and `popstate`, and — because none of the three fires for `history.pushState`, which is how every current router changes route in history mode — polls the frame's own `location.href` every `navigationPollMs`. Everything the four signals produce goes through one 300ms settling window, is compared against the last address reported for that frame, and becomes one `content/navigated` event carrying the page id, the path, the document title and `by: 'user'`. A frame that has left the dsh origin answers every read with a `SecurityError` and the watch reports nothing; the frame's own `history` is never patched, because that document belongs to the deployment and an application wrapping it afterwards would take the patch straight back out.

**Where the column stands is a prompt context, not a message.** `content:column` (order 130) lists what the column holds, newest first, with the entry in front marked and — for a page whose frame has moved away from its configured address — the address it is at now. What it costs is the deployment's to set: `contextEntries` bounds how many it lists and `contextFieldChars` how much of a name each line carries, because this block rides every request and a console whose users keep a dozen things open pays for it on all of them. It is registered as a *context* rather than a section for the reason `approval:policy` is: the value changes as the user works, and a context is materialized after the retained history, so a column that moved does not rewrite the stable system-prompt prefix the provider caches. Nothing in it is timestamped: a relative time would differ between a live run and its replay, and the conversation already carries the order things happened in.

All three fold from this session's own log — `contentSurface`'s entry stream and this package's `contentPages` state, which records who opened each page and where its frame went. `contentPages` is host-only: no browser reads it, so it carries no `wire`.

<a id="reading-a-page-that-has-not-finished-drawing-itself"></a>
## Reading a page that has not finished drawing itself

A frame that has fired `load` is not a page that is done: a single-page application fetches, paints, and repaints for as long as it takes, and a read landing in the middle of that is a listing of a page the user never saw. So a read waits, after the load wait and before the walk: a `MutationObserver` over the frame's document, answering as soon as the document has held still for `settleQuietMs`, and giving up at `readTimeoutMs × 0.25`. The two shares of the report deadline — half for a page still loading, a quarter for one still drawing — leave the walk and the trip back the rest.

The wait's two outcomes both reach the model. A page that never settled is read anyway, with `The page was still changing when this read ran; read again for the settled page.` on its own header line: the listing is a real read of that instant, and reading again is what turns it into a listing of the page as the user has it. And whatever the page marks `aria-busy="true"` while visible is named on a header line of its own, at most three, through the same naming ladder the listing uses. `role="progressbar"` is not a busy mark — a page can draw one as its subject — and no framework's loading class is read, because this reader has never heard of one.

`content/navigated` does not wait: an address change is reported the moment the frame settles at it, and waiting for the page behind that address belongs to reading it. Refs are invalidated by the engine on its own terms — the ref table is reset when the frame loads a new document, a ref whose element left the document resolves to nothing, and a stale `scope` or `after` is refused with a message telling the model to read again.

<a id="hiding-the-show-content-page-command-from-the-chat-transcript"></a>
## Hiding the `show-content-page` command from the chat transcript

A user's page click is a command invocation, and every command leaves a `command/run`/`command/done` pair on the log — the durable record the sidebar menu and every replay rely on. Left alone, `dsh-client-ui-conversation`'s chat view renders that pair as an ordinary command row ("Now showing `<title>` in the content column."): informative for the agent's own commands, redundant for a click the user just made. The browser half registers an empty component into `conversation.chat.commandview`'s `show-content-page` key — the keyed slot every command row dispatches through — so the row's business content never appears.

An empty registrant still leaves a zero-height flex item in the chat column, and the column's `gap: 16px` reserves space for it regardless of height. The browser half also injects one CSS rule collapsing that specific empty row (`[data-chat-flow-kind="command"]:has([data-slot="conversation.chat.commandview"]:empty)`), coupled to two DOM shapes this package does not own — `dsh-client-ui-conversation`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper — see Known Limitations.

<a id="composition"></a>
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

The card the picture read puts up needs a `userQuestions` answerer and `ctx.sessionController` in the same composition; the Web surface mounts both. Without either, the picture read refuses a text-only route the way it did before the card existed, and the other six tools are unaffected.

`dsh --profile web --patch <path>` applies it. The overlay reads the directory from the environment so one file serves any application; a deployment that hosts a fixed one writes the literal absolute path in its place. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

The empty `pageAccess` block is this service line's own choice: it takes every default and is what lets the agent see the page it put in front of the user. Drop the line and the column still works exactly as it did.

The tools, the command, the projections, and the page extractor are optional children: a composition without `ctx.tools`, `ctx.commands`, `ctx.sessionProjections`, or `ctx.contentSurface` keeps the routes and shows nothing in the column, and no absence fails the row.

<a id="the-copy-rule"></a>
## What the tools say and what they never say

Two rules hold over this package's tool copy — every tool description, every parameter description, every refusal and failure text, every result hint, and every field description of an output schema — and [the self-contained-copy Agent Note](../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md) owns why. The request-context lines in `src/perception/text.ts` are outside the rules and still name `content_read` and `content_show`: they are [the content-column context](#the-content-column-context), the model's map of the channel rather than one tool's own copy, and the Note's [Where the rules do not reach](../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md#where-the-rules-do-not-reach) section owns them.

**A description describes its own tool, or its own parameter, and names no other tool.** No description says a sibling is cheaper, is the read to start from, or is where a ref comes from; each says what it takes, what it prints and what it answers. The model picks a tool by reading all of them.

**A failure states why the call was refused, and nothing else.** No refusal names a tool to call instead, tells the user to be asked something, or says to retry: the column was empty, the entry in front is not a page, no visible console tab claimed the call within the wait, the answer ran past the budget. A refusal does name this tool's own parameter where the parameter is the reason — `scope must be a ref like "e12" printed by an earlier read of this page` — because that is the reason and not a remedy.

The rules changed together after an A/B on a real console: two prompts, one fresh session per cell, cross-referenced copy against self-contained. Under the cross-referenced copy the refused call was `content_read` with `mode: "dom"` in prompt A and `content_read` with `scope: ""` in prompt B, one each. Under the self-contained copy prompt A went straight to `content_read_dom` and then spent two calls on `content_read` with `mode: "find"`, and prompt B opened with `content_read` and `scope: "__page__"` — two refused calls and one. The misroute the change targets did not recur; both conditions still invented a `scope` value on a first call and read a word as a `mode` value, which is why that parameter line now says omitting `scope` reads the whole page. Total calls fell 13→11 and 11→9, whole-tree DOM reads fell 3→1 and 2→1, and all four cells answered correctly; with n = 1 per cell and temperature uncontrolled those counts are observations, not measurements. [`tests/self-contained-copy.client.spec.ts`](tests/self-contained-copy.client.spec.ts) walks both text modules' whole export surface, the listing a read answers with, and every description of the seven assembled tool definitions, and fails on any tool name in any of it.

<a id="model-experience"></a>
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

A successful call answers with exactly `Now showing <title> in the content column.` or `Content column cleared.` An id the deployment does not configure answers `Error: unknown page "<id>". Available pages:` followed by the whole catalogue again, so the model corrects itself from the result instead of guessing at a retry; that call changes nothing. A call with no owning session answers `Error: This call has no owning agent session`. The `content/shown` session event each successful call appends is UI and replay state, not a second model message.

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

A successful read answers with one text block: a `Page: <title> — the app is at <path>, title "<document title>"` line and, each on its own line, the name of any dialog the page has open, what the page marks as still loading, and whether it was still changing when the read ran — followed by the listing itself. A whole page too large for the budget answers with the page's map and says so on that first line; a listing cut short ends with the cursor to pass back as `after`. Every other ending is an error stating why the read was refused and nothing more — an empty column, an entry that is not a page, a page still loading, a budget the first block ran past, a claim window that passed. One of them takes two forms, because a column holding something is half the reason: over an empty column the claim timeout is the wait alone, and over a column with something in front it names that entry by its own kind word — `the chart "…"` for a chart — because the column's key domain is open. A composition with no projection registry reads no column and takes the first form.

##### The claim timeout over an empty column

```markdown
No open, visible console tab is showing this session's content column (waited 3s).
```

##### The claim timeout over a column with an entry in front

```markdown
No open, visible console tab is showing this session's content column (waited 3s); the page "点位信息" is already in front.
```

#### Token effect

Bounded by `outlineChars` — a listing is rendered under that budget, so one read costs at most that much plus the header line. The two answers that keep a read from ever being a blind cut, the map and the cursor, are what the budget buys.

#### KV Cache effect

Append-only. The listing is a fact about the page at that moment; a second read of a changed page is a new result rather than a rewrite of the first.

### The three markup-read offers

#### What the model sees

Three tools beside `content_read`, offered on the same `pageAccess` condition. `content_read_dom` takes `scope` (required) and `after`; `content_read_attrs` and `content_read_dom_content` take `ref` (required) and nothing else. Each description says what the tool prints, what it answers, and that nothing in it is interpreted, and names no sibling. The risk that rule gives up naming is real: a model shown a way to read a page's real markup may reach for it first, and a whole page of markup is an order of magnitude larger than the listing it would have got. What is left standing against it is `content_read_dom`'s required `scope`, which makes a prior read the only way to call it at all.

#### Token effect

Three fixed descriptions and four parameter lines between them, on every request where the tools are visible.

#### KV Cache effect

The descriptions are constants and never vary within a deployment, so the tool blocks stay byte-identical across requests and the prefix holds.

### A markup read's result

#### What the model sees

One text block opening with `Page: <title> — the app is at <path>` and, on its own line where it applies, the same still-changing sentence a listing carries — and then the tree, the attributes, or the text. The header is shorter than a listing's by the three facts these reads do not answer: what the document calls itself, what dialog it has open, and what it marks as still loading are questions about the page, and `content_read` is the read that answers them.

##### A tree of the rows a listing named nothing

```markdown
Page: 点位信息 — the app is at /content-app/points/
e33 tbody {class: el-table__body}
  e34 tr {class: el-table__row}
    e35 td {class: el-table__cell}
      e36 i {class: el-tooltip operation-modify el-icon-edit}
```

##### One element's attributes

```markdown
Page: 点位信息 — the app is at /content-app/points/
e36 i
  class="el-tooltip operation-modify el-icon-edit"
  data-op="edit"
```

##### A text too large for one result

```markdown
The text of e12 comes to 61204 characters, past what this deployment's report route carries (pageAccess.outlineChars is 12000).
```

#### Token effect

The tree is bounded by `outlineChars` and returns a cursor, like a listing. The other two are bounded by nothing they cut: an element's attributes and an element's text arrive whole, and an answer past what the report route carries is refused with its size rather than shortened, so the cost of one of those calls is the size of what it asked for.

#### KV Cache effect

Append-only. Each answer is a fact about the page at that moment, so a second read is a new result rather than a rewrite of the first.

### The `content_read_image` offer

#### What the model sees

One tool, `content_read_image`, offered on the same `pageAccess` condition and only where an attachment store is mounted. One required parameter, `ref`. The description says what the element has to be — an `img`, `canvas`, `svg` or `picture` — and what the export does to it, because both are conditions on the answer rather than advice: a page draws its codes and its icons in those four tags and in no other, and a picture the browser will not let this console export has no answer at all. It closes by saying the session's model must accept image input, which is the one condition the page has nothing to do with.

#### Token effect

One fixed description and one parameter line, on every request where the tool is visible.

#### KV Cache effect

The description is a constant and never varies within a deployment, so the tool block stays byte-identical across requests and the prefix holds.

### The picture result

#### What the model sees

Two blocks. The first is text: the same `Page: <title> — the app is at <path>` line every markup read opens with, the still-changing sentence where it applies, and one line of facts. Both sizes are on that line because they answer different questions: the natural size is what the page draws, and the exported size is what the model is looking at, so a small picture enlarged to stay legible and a large one scaled down to the budget both show up as the two differing. The second block is the picture itself, an image block referencing the stored attachment. Every ending that is not a picture is one line naming the condition it found and nothing else — a ref that is not a picture, an element hidden (`e12 is not visible on the page, so it has no rendered pixels.`), still loading (`e12 has not finished loading its image.`), drawn at nothing (`e12 is drawn at zero pixels.`), drawn by another origin, too large, one the console did not finish drawing inside the share of the read's deadline the export gets — an eighth of `readTimeoutMs`, so `e12 did not finish exporting within 1.875s.` at the default — or a session whose model takes no pictures at all.

##### One picture, and the line above it

```markdown
Page: Home — the app is at /content-app/
e12 <img> 240×240 px, exported 240×240 as image/png, 3182 bytes
```

##### A ref that names no picture

```markdown
e12 is a <div>, which carries no picture of its own.
```

##### A picture the browser will not export

```markdown
e12 is drawn from another origin, and a browser does not let those pixels be exported.
```

##### An export too large for one result

```markdown
e12 exports to 3145728 bytes, past the 2097152 bytes one image may carry.
```

##### A session whose model takes no pictures

```markdown
The session's model "deepseek-v4-flash" does not declare image input.
```

##### A deployment where no model takes pictures

```markdown
The session's model "deepseek-v4-flash" does not declare image input, and no configured model does.
```

##### A model change the host would not make

```markdown
The session's model could not be changed. no adapter registered for provider "deepseek-official"
```

#### Token effect

The text block is two lines. The picture costs what the provider prices it at: 117 tokens for anything at or under 384 × 384 after its own floor, 201 for 512 × 512, and 349 for a square picture at the whole 640,000-pixel budget — never more than the provider's own 384-token cap (`MAX_IMAGE_TOKENS`). That is cheap against a subtree of markup and is not a substitute for one: it answers what one element shows, and nothing about what the page is.

#### KV Cache effect

The picture enters the request as a synthetic `user` message immediately after the tool result that produced it (`packages/llm/llm-deepseek/src/serialize.ts`), so the request suffix changes from the first picture read onward while the prefix in front of it still holds.

### The `content_act` offer

#### What the model sees

One tool, `content_act`, offered beside `content_read` wherever the deployment configured `pageAccess`. Two parameters: `steps`, required, each `{action, ref, label, mark?, text?, value?, key?}` — `mark` being how a step names a row the read printed with no name, `label: ""` beside the class tokens that read printed for it and nothing around them — with `action` one of `click`, `fill`, `select`, `press`, `wait`; and `dialogs`, `cancel` or `accept`, for a native dialog the page opens while the steps run. The description says the label is checked against the page before the browser acts, so the model knows a stale read stops the call rather than acting on the wrong element, and that one call is one approval request, which is the cost model behind putting the steps that belong together in one call.

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
Page events during these steps: none.
Page now:
1 main
  2 heading "点位信息"
  3 table "点位列表" — 名称, 状态, 操作 · 24 rows · e14
```

##### A call one step stopped

```markdown
Step 2 failed: e5 is now "重置", not "查询" — the page changed. Step 1 ran; later steps were skipped.
Page events during these steps: none.
Page now:
1 main
  2 heading "点位信息"
```

##### The console claimed the call and went quiet

```markdown
The console claimed this call but did not report within 60s; the steps may have run partially or fully.
```

#### Token effect

Bounded by `outlineChars` for the closing reading, plus one clause per step on the first line, plus at most eight lines of what the browser did on the page's own account, each cut to 200 characters. A call that changed the page therefore costs about what a read of it costs, which is the point: the model does not have to read again to see what it did.

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

<a id="known-limitations-and-deferred-work"></a>


- **The card is Chinese, whatever language the console is set to** — `locale` is a browser-side service and the host has none, so the card's four lines are host-side literals, the same way the `content_act` approval request is. An English console shows them as they are.
- **Nothing changes the model back** — a session moved to a vision model stays there, and the model it left may have been the better one for the rest of the conversation. `selectModel` also saves the choice as the deployment's default, so a session opened afterwards starts on the new model as well; the card says the conversation will keep using it and says nothing about the default.
- **The one-card mark is per process** — a user who declines is not asked again in that session, but the mark lives in memory, so a reloaded session or a restarted host asks once more. A card that ended in anything other than a decision — no console open to answer it, a dropped connection, an answerer that threw — leaves no mark at all, so the model's next attempt raises another card.
- **The card lists every image-capable route, however many there are** — no cap, no ordering, no recommendation. A deployment with many vision routes configured produces a card with an option for each of them.
- **Two providers registered under one display name are indistinguishable on the card** — an option's label is the provider's display name, the model's display name, and, where two would otherwise read the same, the model id. Two provider routes registered under one display name and listing one model id therefore produce two options that read alike, and the first of them answers for both.
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
- **A control the page names nowhere is acted on by its class tokens alone** — the model can only copy what the listing printed, and the seat checks what it copied against the page. A box is named by its label, its `aria-label`, or the word written inside it (`placeholder`, `aria-placeholder`); a control with none of those prints its class tokens instead, and a step carries that string as `mark`. A control the page names nowhere and gives no class either prints nothing to copy, and no step can name it.
- **A step's target is checked by name, which is not identity** — two rows whose buttons are both called `编辑`, or whose unnamed icons carry the same class tokens, are the same to this check, so a re-render that reordered them passes it. The ref is what names the element and the name is what catches the page having moved under it; neither one alone is an identity, and a page that renumbers and renames together is a page a read has to be taken of again.
- **The dialog stand-ins are the one injection into the page** — for the length of a call, `confirm`, `alert`, `prompt` and `window.open` are this package's, in the frame's own document and in every same-origin frame the reader walked into, restored when the call ends. A page that captured its own references to them before the call keeps calling the originals, and a page that opens a dialog outside a call blocks its own frame as it always did.
- **A toast that came and went is in nothing** — only what the browser did on the page's own account is reported: the dialogs it opened, the addresses it moved to, the windows it tried to open, at most eight per call and each cut to 200 characters. Text the page drew and took away again while the steps ran is in no read and in no line of the report, and a page that says what it did in a toast alone says it to nobody.
- **A call is scoped to the documents it started with** — the stand-ins, the route watch, the `wait` step and the settle wait all cover the same-origin documents the reader walked when the call began. A frame the page adds while the steps run is in none of them: what it draws is left to the closing snapshot, and a dialog it opens blocks the tab as it would have without this package.
- **`dialogs: accept` is spent by the call that was asked about** — the record is consumed on use, so a retry of the same call cancels the page's dialog instead of confirming it, and asks the user again.
- **The `content` projection has no in-tree consumer** — the column reads the entry stream instead, and `content` remains only as the resolved current-page value (`shown`/`default`/`empty`/`missing`) for anything else reading the wire. It is the one place `defaultPage` still shows up.
- **The frame cache is per browser tab and unbounded in time** — `cacheSize` bounds how many frames stay alive, not how long. A tab left open keeps its cached documents running, including whatever polling or sockets they hold.
- **The settings route assumes an HTTP carrier** — the browser half fetches `/content-frame/settings` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way the iframe's own route would.
- **No sandboxed profile for untrusted content** — see the trust boundary above. Hosting content that must not carry the shell's authority is a separate plugin that this one does not provide a flag for.
- **Only a `label` names a field the page tied nothing to** — a page that draws the words in a `div` or a `span` leaves the field unnamed rather than risk naming it after a notice drawn beside it, however long that label runs. A field taking its name from a `label` drawn inside a longer run keeps that run as a row too, so those words reach the reader twice.
- **A star a stylesheet draws says nothing here** — a form marking its required fields with a drawn `*` and no `required` attribute reads as a form of optional fields.
- **A command a page draws with nothing but a class of its own reaches the read as nothing** — a component library's row commands (`<i class="el-tooltip operation-modify el-icon-edit">`) carry no role, no name, no title, and no pointer cursor, so no row is printed for them and the column they fill reads as empty. Measured on that console on 2026-09-03: a whole-page read is 2507 characters and six tables, and `e33` — the body pinned to the right, where the 操作 column is drawn — prints twenty rows with every cell empty. Where the page does mark such an element as something to click, the row it prints carries the class tokens and no name; the same read prints `e3 button {class: el-button el-tooltip head-btn el-button--text …}` for a command drawn as a button — that read cut the tokens at four, which this build no longer does. What either says is a skill's to know: the reader states what the document says and guesses nothing from a vendor's spelling.
- **A table a component library draws in pieces reaches the model as those pieces** — a frozen header is one table and the body under it another, a pinned column is a third, and a page that draws its list six times over reads as six tables with the columns split between them. Nothing is merged: which pieces make up the table a user sees is a skill's to know.
- **The session card shows the line and not the picture** — the `tool.call.images` child slot upstream is declared by exactly one entry (`packages/client/ui-tool`'s `read-image` row, and `packages/client/ui-slots` throws at load on a second declaration), so this package registers no toolview and the settled card falls back to the generic one, which shows the header line. The picture reaches the model regardless; showing it in the card needs that slot to become keyed or to accept more than one declaration, which is an upstream change this package does not make.
- **A WebGL canvas may export a blank frame** — a context created without `preserveDrawingBuffer` has nothing to read back after it has composited, and whether a page created one is not visible from outside it. The export succeeds and the pixels are empty; nothing here can tell that from a page that drew nothing.
- **A vector that points outside itself rasterizes without what it points at** — an `svg` is serialized as it stands, so an external stylesheet, a webfont glyph, or a linked image is not part of what is drawn. What the element holds inline is what comes out.
- **`video` is not read, and neither is a subtree** — there is no frame grab and no way to rasterize a region of the page: the read takes one element that has pixels of its own. Rasterizing arbitrary markup means a DOM-to-canvas dependency, which this package does not take.
- **A stored picture is permanent** — the attachment store keeps what it is given and collects nothing (`packages/attachment/attachment-local/README.md`), so every picture this read exports stays in `$DSH_HOME/attachments/` for the life of that home and travels with any export of the session log. A sign-in QR code read once is a sign-in QR code kept forever.
- **The corpus holds the recordings, and the browser lane replays them** — the four content scenarios live under `snapshots/web/` with manifests declaring the `web-content` composition, so `pnpm run test:snapshot` enumerates them and holds their storage invariants; the replay itself is the Web browser lane's, because these scenarios boot a patched composition and the shipped one composes no experimental row. The model-visible text is pinned verbatim in unit tests besides.
- **The read routes carry no Host fence** — like the shell's own `/api`, they refuse a request a browser labelled `sec-fetch-site: cross-site` and require `application/json`, but neither check survives DNS rebinding, and the webserver has no Host allow-list of its own (`trustedHosts` guards `/api` alone). What stands in its place is the call id: an attacker who reaches the routes can neither claim a read nor answer one without knowing an id the host minted and published only into that session's own projection stream, and a claim or report for an unknown id changes nothing. That id's unguessability is the LLM provider's property, not this package's — DeepSeek mints `call_00_` plus twenty-four alphanumeric characters whose last four are digits, and a code-mode subcall is that same id plus `:code:<n>` — and nothing here checks the format or strengthens it, so a provider numbering its calls `call_1`, `call_2` would leave both routes open to any page that can reach this host. A deployment exposing the harness to an untrusted network needs a fence at its reverse proxy, as it does for every other route.
- **Which entry is "in front" is the page seat's answer, not the log's** — which entry the user picked is a viewing decision the column keeps in component state, so a read reaching a session whose column holds several other kinds says the entry in front is not a page without naming which one it is.
- **A read carries structure, never data** — there is no mode that returns a table's contents, and none is planned here: a listing is what the model needs to point at the page, and the data behind it belongs to whatever produced it.
- **A markup tree stops at the frame it started in** — `content_read_dom` walks an open shadow root in place of the light children it renders, and prints an `iframe` as the one element it is rather than descending into that frame's document. A ref inside a same-origin frame still works as `scope`, because the listing walks into those frames and numbers what it finds there; what has no ref has no way in.
- **A markup tree prints what the page hides** — visibility is the listing's filter and deliberately not the tree's: a row the listing dropped for being invisible is exactly what a reader comes to the tree for. A page with a large hidden subtree therefore spends budget on it, and the cursor is the only thing bounding that.
- **A tree line's text allowance is the reader's own number** — 80 characters, chosen against a line whose job is to say which element this is; past it the line says so and names the ref `content_read_dom_content` prints the rest from. It is not a `Config` field, for the reason the listing's own 200-character run is not one.
- **One element's attributes have no narrower read** — the tool answers all of them or refuses. An element carrying a data URI or an inline stylesheet larger than the report route allows is unreadable through this tool at that deployment's `outlineChars`, and the refusal says so rather than offering a call that cannot help.
- **`content_read_dom_content` stands in for `innerText` rather than calling it** — the seat has to answer for documents in a DOM implementation without layout, so a line breaks where the element is not an inline one and at a `<br>`, which is the rule a page's markup states rather than the one its stylesheet produces. A page that makes a `span` a block, or a `div` inline, is broken the way its markup reads and not the way it is drawn. The inline set is this package's own — phrasing content less what a browser draws itself and less what a user operates — so `del`, `ins`, `button`, `input`, `output`, `select` and `slot` break a line here where a browser would have kept one.
- **jsdom cannot stand in for the frame** — it has no layout and never loads a frame pointed at a real route, so the package's own suites read hand-mounted documents and the real path is covered by the browser lane alone.
- **The empty-command-row CSS collapse is a DOM-shape coupling, not a contract** — it keys off `dsh-client-ui-conversation`'s `data-chat-flow-kind` attribute and `dsh-client-ui-renderer`'s `data-slot` anchor wrapper, neither of which this package owns or that package promises to keep. A future change to either shape silently un-collapses the row (it reappears with its 16px gap) rather than failing loud; the `server-sidebar.e2e.ts` scenario asserting the row stays invisible is this coupling's only tripwire.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
