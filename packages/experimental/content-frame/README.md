# @deepseek-ai/dsh-experimental-content-frame

English | [中文](README.zh.md)

The first occupant of the service-line shell's content column: a directory of static files on the host, served under one dsh route, shown in an iframe that fills the column. The application inside is written and deployed by whoever runs the harness — this package neither builds it nor knows what framework it uses.

Both halves are defined against one path, `/content-app`. The node half claims it as a webserver prefix route over the configured directory; the browser half registers an iframe pointed at `/content-app/` into [`server-layout`](../server-layout/README.md)'s `content` slot. `content` is a `single`, `session-maybe` slot, so the frame is the column's only occupant, and the renderer's adoption rule decides how long one frame lives: the incarnation the page boots into adopts the first session the user opens, so the application survives that click, and every session change after it mounts a fresh frame that reloads the application.

## Trust boundary

**The hosted application runs with the shell's own authority.** It is served from the dsh origin and the iframe carries no `sandbox` attribute, which makes the document same-origin with the shell: it can call the dsh HTTP API — sessions, tools, settings, everything the browser can reach — without any further permission. `root` must therefore name a directory whose contents are trusted exactly as much as the harness itself.

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
```

`dsh --profile web --patch <path>` applies it. The overlay reads the directory from the environment so one file serves any application; a deployment that hosts a fixed one writes the literal absolute path in its place. Both packages must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Model Experience

None, as the package serves an operator-configured directory to one browser iframe; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A session change reloads the application** — after the first adoption, `session-maybe` behaves like a strict session scope: the renderer mounts a fresh frame for every later switch, so whatever state the hosted application held is gone. Anything that must survive belongs on the application's own side (its server, `localStorage`, the dsh API), not in its page. A column that outlived sessions would need a `root`-scoped seat, which is the shell's declaration to change, not this package's.
- **One application, one page** — the route serves a single configured directory and the column shows its entry document. There is no page switcher, no second application, and no way to address a sub-path of the hosted application from the shell.
- **No channel between the frame and the shell** — no `postMessage` protocol, no shared state, no way for the hosted application to ask the shell to open a session or for the shell to tell it what is selected. The application's only route back into the harness is the dsh HTTP API, which it reaches on its own.
- **The agent cannot drive the frame** — no tool, no session event, and no projection. What the column shows is not model-visible and not reconstructable from a session log.
- **No sandboxed profile for untrusted content** — see the trust boundary above. Hosting content that must not carry the shell's authority is a separate plugin that this one does not provide a flag for.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
