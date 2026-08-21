# @deepseek-ai/dsh-experimental-content-frame

English | [中文](README.zh.md)

The first occupant of the service-line shell's content column, and the agent's control over it: a directory of static files on the host, served under one dsh route, shown in an iframe that fills the column — with the agent choosing which of the deployment's pages is in it. The application inside is written and deployed by whoever runs the harness; this package neither builds it nor knows what framework it uses.

Four pieces, one decision each. The node half serves the configured directory under `/content-app`. `content_show` offers the deployment's page list to the model and appends `content/shown` when it chooses. The `content` projection resolves that recorded id against the page list running now, so the browser receives a finished `{state, url, title}` and resolves nothing. The browser half claims [`server-layout`](../server-layout/README.md)'s `content` slot and keeps one live frame per session.

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

A second, exact route — `/content-frame/settings` — serves the browser half the one configured value it must obey, `cacheSize`. It exists because a browser half receives no cordis config at all: the boot manifest carries plugin names, not their `config` blocks. An unreachable or unusable settings document fails the browser row rather than letting the column run on a bound nobody chose.

## Pages the agent may show

`pages` is the deployment's whole vocabulary for the column, and at least one entry is required — `content_show` exists to choose among them. Each page declares an `id` the agent passes, a `title` the user reads, a `description` written in the agent's terms (it becomes the catalogue line in the tool description), and a same-origin `url`. A URL that names a scheme or a host fails the row at load: the frame carries the shell's authority, so it may only address the dsh origin.

`defaultPage` names the page shown before the agent has chosen anything and after it clears the column; omitting it leaves the column empty until the agent fills it. `id` may not be `none`, which the tool reserves for clearing.

## One live frame per session

The column is a `root` slot, so the framework never remounts it, and the browser half keeps every cached session's iframe mounted at once with all but the current one hidden. A session the user returns to therefore finds its page exactly as it left it — scroll position, form state, whatever the document holds — because the element was never destroyed. `cacheSize` bounds how many survive; past it the least recently shown one is dropped and reloads when its session comes back. The current session's frame is never the one dropped.

## Composition

Neither this package nor the shell is part of any shipped bundle. `overlay/content-column.patch.yml` composes both over the Web surface — the shell replaces `ui-layout`, and this row claims the column it opens:

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
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
```

`dsh --profile web --patch <path>` applies it. The overlay reads the directory from the environment so one file serves any application; a deployment that hosts a fixed one writes the literal absolute path in its place. Both packages must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

The tool and the projection are optional children: a composition without `ctx.tools` or without `ctx.sessionProjections` keeps the route and shows the empty column, and neither absence fails the row.

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

## Known Limitations and Deferred Work

- **`content/shown` is required on read** — the event carries no `ignorable` marker, so a runtime whose session vocabulary does not include it refuses the whole log rather than skipping the event. Any build of this repository knows the type; a separately built runtime that excluded this package would not.
- **One directory, one origin** — the route serves a single configured directory, and every page must be a path inside the dsh origin. There is no second application, no external URL, and no way for the agent to name a page the deployment did not configure.
- **No channel between the frame and the shell** — no `postMessage` protocol, no shared state, and no way for the hosted page to report back what the user did in it. The agent can put a page in front of the user; it cannot learn what happened next except by being told. The page's only route back into the harness is the dsh HTTP API, which it reaches on its own.
- **The frame cache is per browser tab and unbounded in time** — `cacheSize` bounds how many frames stay alive, not how long. A tab left open keeps its cached documents running, including whatever polling or sockets they hold.
- **The settings route assumes an HTTP carrier** — the browser half fetches `/content-frame/settings` relative to the page origin. A transport that serves the shell without exposing the harness over HTTP would fail the row, the same way the iframe's own route would.
- **No sandboxed profile for untrusted content** — see the trust boundary above. Hosting content that must not carry the shell's authority is a separate plugin that this one does not provide a flag for.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, and the model-visible text is pinned verbatim in unit tests; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
