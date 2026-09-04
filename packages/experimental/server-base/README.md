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

`deploy/nginx.console.conf` is the matching reverse-proxy sample: `location /console/` and `proxy_pass http://127.0.0.1:3080/`, both with the trailing slash that performs the stripping, `Host` forwarded unchanged, the WebSocket upgrade headers for the two event sockets, and buffering off for streamed answers. It is written for an nginx built without `ngx_http_rewrite_module` but with `ngx_http_auth_request_module`, so it uses no `rewrite`, `return`, `if`, or `set`, and it publishes only the slash-terminated prefix: nothing available there can redirect `/console` to `/console/`, and a document served at the slashless address sits outside the `Path=/console/` a page writes its mirror cookie with, so the browser sends none back. Every link published outward carries the trailing slash.

dsh authenticates nobody, so that sample also carries the deployment's only authentication: an `auth_request` gate declared once on the `/console/` location and cancelled address by address beneath it. It is therefore deny-by-default — `/console/api` with both event sockets, every route a composed plugin registers, and the content app are all gated without being named, where a gate on an entry point alone would have left the RPC uplink open. What the sample does open is the bootstrap, and it has to: the credential a navigation can carry is the cookie auth-gate mirrors the token into, and the only thing that writes that cookie is the console's own page. A gate over the document as well would make itself and its own only credential each other's precondition, and a visitor with an empty cookie jar — a first visit, another browser, cleared site data, or the sign-out that clears this very cookie — would be refused at the one page that could have written it, with no path back. So the shell document, the files it references, the client plugin bundles, and the gate's own `/auth-gate/settings` document are served to anyone. What that publishes is build output plus two facts about the deployment — the composed plugin list and the stored theme preference the shell document carries, and the three configured values in the settings document — and no conversation, session, or workspace content. The in-page gate, whose login page must itself stay reachable outside this one, decides on shape and expiry alone: a stored value that is not a JWT with an `exp` still ahead sends the visitor to the login page, and nothing else does. The check that proves this half, to re-run whenever that list changes: with an empty cookie jar, `GET /console/` answers 200 and the shell document while `GET /console/api/anything` answers 401 and the fixed page.

nginx holds no signing key and validates no token. It presents the caller's credential to the deployment's own authentication service and reads only the status: 200 admits the request, 401 and 403 both refuse it, so expiry, rotation, and revocation stay with the service that issued the token. The credential is the `Authorization` header when a surrounding product's page sends one, and otherwise that mirror cookie — which is what covers every asset, each iframe, and the two WebSocket handshakes, none of which can carry a header. The sample's cookie name must be spelled the same as that auth-gate row's `cookieName`; any other spelling reads an empty cookie and closes the console to everyone. Answers are cached by token for 30 seconds, which is also the longest a revoked token keeps working, and the cache file's key puts that token on disk; `Set-Cookie` and `Vary` are ignored on those answers, because a session endpoint renewing its own cookie would otherwise leave every entry unstorable and degrade the gate to one upstream call per console request. A refusal serves a fixed page the deployment supplies, not a redirect: nothing there can redirect, and an `/api` or WebSocket request needs a status rather than a login document. The hop that carries the question is verified TLS — this is the deployment's only authentication decision, so the sample turns `proxy_ssl_verify` on against a named trust store, and an authentication service reached over plain http on a private network is the other supported form. An answer that is neither 200 nor 401 nor 403, and a service that cannot be reached at all, becomes a 500, which a second fixed page answers: temporarily unavailable, rather than sign in again.

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
- **The gate does not cover the shell itself.** The document, the files it references, the client plugin bundles, and `/auth-gate/settings` are served to anyone who asks: the in-page gate writes the only credential a navigation can carry, so gating them would leave a visitor with an empty cookie jar no way in. What that publishes is build output plus three configured values, and the console paints before the visitor is known — the window auth-gate's own Known Limitations record. A deployment that must not hand its shell to an anonymous request needs a gate that can issue the credential itself, which is a different sign-on from this one.
- **A refused token that has not expired strands the visitor.** The in-page gate decides on shape and expiry alone — a stored value that is not a JWT with an `exp` still ahead is what sends the visitor to the login page — so a token the authentication service refuses while it is still unexpired (revoked, signed with a rotated key, an account since disabled) is usable to it and a refusal to the site gate. That visitor is served the bootstrap, the console paints, and every gated request behind it fails: a navigation outside the open list lands on the fixed page, and the page's own calls keep failing until the token's own expiry or a press of sign out. Leaving for the login page on a 401 from the page's own calls is the missing half, recorded in [auth-gate](../auth-gate/README.md)'s Known Limitations.
- **Sign-out cannot always reach the process.** auth-gate's sequence posts `/auth-gate/logout` first, so the node half stops spending a credential the visitor no longer has, and that request carries the mirror cookie this gate validates rather than merely routes by. On the paths that surrender a token the gate refuses, nginx answers that post 401 and the process keeps the dead token until it ends or a newer one is posted. The visitor still leaves, because the steps after it run whatever the one before did.
- **A URL leaving the page is not covered.** `<base>` and `__DSH_BASE__` govern URLs the page resolves; anything handed to something else — a download the browser's download manager fetches, an address copied into another tab — must already be absolute. Those call sites build absolute URLs themselves and this package does not check them.
- **Not covered by an assembled snapshot** — the evidence is this package's real-composition suite against a served index; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
