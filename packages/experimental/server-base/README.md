# @deepseek-ai/dsh-experimental-server-base

English | [中文](README.zh.md)

Tells the browser which path prefix a dsh process is served under. A process never learns that by itself: the web server reads no forwarded-prefix header, and every route it owns — `/api`, `/plugins`, the shell's static dist, each plugin's own path — is registered root-absolute. A reverse proxy publishing the shell at `/console/` therefore has to strip that prefix before the request arrives, and what comes back is a page that would address all of those routes from the origin root again. This package closes the browser half.

It exists for the deployment that cannot have a hostname of its own: several products behind one domain, dsh among them, separated by path. A process at the origin root does not need this row.

## What it injects

Two rows on `webserver/index-inject`, both carrying the configured `basePath` and nothing else:

- `{ kind: 'html', placement: 'head', html: '<base href="/console/">' }` — the HTML parser resolves every relative URL after it against this value: the built shell's own asset references, and the parser-blocking plugin-bundle tags the client module system contributes.
- `{ kind: 'global', name: '__DSH_BASE__', value: '/console/' }` — the value runtime code reads when it builds a fetch, WebSocket, or EventSource URL. It is a `<script>` in the head, so it is set before any document script runs, and it is defined in carriers that have no document at all.

Both are needed. `<base>` reaches markup the process does not generate and cannot reach a URL built at runtime; the global reaches runtime code and cannot reach a tag the parser has already acted on.

The listener is registered with `prepend`, which is what puts the `<base>` row first in the rendered head. `<base>` governs only the URLs that follow it, head rows render in table order, and nothing orders plugin activation — a row contributed by a listener that ran earlier would otherwise resolve against the document URL while the rest of the page resolved against the prefix.

For the `<base>` element to have anything to act on, the shell's own asset references must be relative: `apps/web/vite.config.ts` sets `base: './'`, which is what makes the built `index.html` reference `./assets/…` instead of `/assets/…`. Building with `base: '/console/'` instead would bake one prefix into the artifact, and one build could then serve only one deployment.

## Configuration

`basePath` is the path as the **browser** addresses it, leading and trailing slash included — `/console/` behind `location /console/`, `/` at the origin root. It is not a server-side route prefix.

Every unusable form fails at load, because the symptom otherwise is a blank page with a 404 for each asset and no statement of what was wrong: a value that does not start with `/`, one that does not end with `/`, one carrying a query string or a fragment, one with an empty path segment (`//`), and one carrying characters outside a plain URL path. That last check is also what makes the value safe to place in the element's quoted attribute with no escaping step in between — `"`, `<`, `>`, and `&` are outside the accepted set.

## Composition

This package is in no shipped bundle. `overlay/base-path.patch.yml` inserts the row over any surface:

```yaml
- insert:
    - id: server-base
      name: '@deepseek-ai/dsh-experimental-server-base'
      config:
        basePath: /console/
```

`dsh --profile web --patch <path>` applies it. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## The proxy half

`deploy/nginx.console.conf` is the matching reverse-proxy sample: `location /console/` and `proxy_pass http://127.0.0.1:3080/`, both with the trailing slash that performs the stripping, `Host` forwarded unchanged, the WebSocket upgrade headers for the two event sockets, and buffering off for streamed answers. It is written for an nginx built without `ngx_http_rewrite_module`, so it uses no `rewrite`, `return`, `if`, or `set`, and it publishes only the slash-terminated prefix: nothing available there can redirect `/console` to `/console/`, and a document served at the slashless address sits outside the `Path=/console/` a page writes its mirror cookie with, so the browser sends none back. Every link published outward carries the trailing slash.

That sample is half the deployment. Forwarding `Host` unchanged is what the `/api` browser-trust fence and its Origin comparison read, and that fence refuses every Host that is neither loopback nor a declared authority — so the process must also carry the public name in `client-connection`'s `trustedHosts`, declared in the same overlay layer as `basePath`. Without it the **process** answers 403 to every `/api` request while the page itself loads, and nginx is not involved in the refusal.

A prefix that is not stripped completely does not fail as a clean 404 either: the un-stripped path leaves the static dist root, and the traversal check refuses it with 403 — a different refusal from the fence's, and equally not an authentication problem.

No `sub_filter` is needed. The prefix reaches the browser as data injected inside the process from one validated value, so there is a single source of truth and nothing for nginx to rewrite; a byte filter could not reach the URLs that matter anyway, because runtime code assembles them from strings that never appear whole in a response.

## Model Experience

None, as this package registers no tool, prompt section, or result: it contributes two rows to the HTML a browser is served, which is decided and rendered outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **`<base>` changes how a bare fragment link resolves.** With `<base href="/console/">` in the document, `href="#section"` resolves to `/console/#section` rather than to the current URL plus that fragment, so a page carrying bare fragment links navigates instead of scrolling. The shell's own markup is checked, but any plugin contributing a raw `href="#…"` inherits the change and has to write the path out.
- **Per-origin browser storage is shared between prefixes.** `localStorage` and `CacheStorage` are isolated by origin, never by path, so two deployments at `/a/` and `/b/` on one hostname share the shell's workspace view, conversation drafts, and any token a page mirrors, and overwrite each other's. Nothing in this package can separate them; a deployment that needs separation needs a hostname per deployment.
- **PWA is not supported under a prefix.** A service worker's scope is decided by its script URL, the shipped registration and cache keys are written for the origin root, and the static `manifest.webmanifest` identity is resolved against the origin rather than the prefix. A server-line profile must leave `apps/pwa` out; composing it under a prefix would install a worker claiming more of the origin than the deployment owns.
- **The prefix is browser-side only.** Nothing teaches the process its own prefix: routes stay root-absolute and the proxy must strip. A deployment that cannot strip — a proxy that must forward the prefix intact — needs the route table, the RPC endpoint parser, the api-proxy path matcher, and the privileged-method fence to learn the prefix together, which is a different change from this one.
- **A URL leaving the page is not covered.** `<base>` and `__DSH_BASE__` govern URLs the page resolves; anything handed to something else — a download the browser's download manager fetches, an address copied into another tab — must already be absolute. Those call sites build absolute URLs themselves and this package does not check them.
- **Not covered by an assembled snapshot** — the evidence is this package's real-composition suite against a served index; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
