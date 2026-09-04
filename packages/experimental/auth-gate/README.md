# @deepseek-ai/dsh-experimental-auth-gate

English | [中文](README.zh.md)

A deployment's own single sign-on, wired into a dsh browser session. The browser half sends a visitor without an access token to the deployment's login page and mirrors the one it comes back with into a cookie; the node half holds that token in memory and spends it on the MCP servers this deployment forwards to. Nothing here issues, verifies, or renews a token — this package carries one that already exists to the two places dsh needs it.

It exists for one deployment shape: a reverse proxy in front of many dsh processes, one per signed-in person, choosing which process a request reaches by verifying the visitor's token itself. That proxy has already decided who is on the other end by the time a request arrives, which is why nothing inside the process checks a signature.

## What the gate does on every page load

1. Read this plugin's browser-facing configuration from `/auth-gate/settings`. A browser half receives no cordis config — the boot manifest carries plugin names, not their `config` blocks — so an unreachable or unusable settings document fails the row rather than letting the gate run on a login address nobody chose.
2. Read `localStorage.accessToken`, and drop a leading `Bearer ` from what it holds. Both halves of that are a contract with the deployment's login page rather than a choice this plugin makes: the key is the key that page writes, and the value is what that page's own HTTP client puts into the `Authorization` header verbatim, scheme included. Everything downstream of this one point — the mirror cookie a reverse proxy reads, the token route, the credential the node half's forward spends — carries the bare JWT, and the token route itself accepts nothing else.
3. **No token, an unreadable one, one with no `exp`, or one already past it** — give the token up and leave for `<loginUrl>?redirect=<the encoded return address>`, which is the page the visitor asked for with the login page's own credential parameters taken out. **Giving the token up** below states the three steps and the order they run in. A token without `exp` is refused rather than treated as eternal, because the gate's whole schedule is built on that claim.
4. **A usable token the cookie does not carry** — write the cookie, then load the page again so the request that follows already carries it.
5. **A usable token the cookie already carries** — run the page, and `POST /auth-gate/token` so the node half can spend it.

While the page runs, a `storage` event — another tab signing in, out, or renewing — is re-read from storage rather than trusted from the event. The same person with a newer token gets the cookie updated and the node half told, with no reload. A different `sub` reloads the whole page, because everything on screen was fetched as somebody else. A token that is gone or expired sends the visitor back to the login page.

### The mirror never loops

This is the failure the design is shaped around: a boot that decides to mirror ends in a reload, and if that reload decided to mirror again, the tab would never do anything else.

The guard is structural rather than a counter. A mirror writes the cookie, **reads it back**, and reloads only when the read-back shows the token. A write that did not take — the page is on plain HTTP, or cookies are blocked for the origin — fails the row with a diagnostic naming the cookie, and no reload happens at all. The reload that does happen finds the cookie in step and takes the `ready` path, which reloads nothing. Neither the token nor any part of it appears in that diagnostic.

### Why the mirror cookie is not `HttpOnly`

The token already lives in `localStorage`, where the deployment's login page put it and where any script on the page can read it. A cookie the page's own script could not read would narrow no attack surface — an injected script would simply read the original — while making the mirror impossible to keep in step with it. `Secure` and `SameSite=Lax` do still apply: the first keeps the cookie off plaintext hops, the second keeps it off cross-site subrequests. `Path` is the deployment prefix the shell is served under — `/` at an origin root, `/console/` behind a path-prefixed reverse proxy — which every request from this page carries and a second harness under another prefix on the same host does not.

The cookie exists because requests that carry no `Authorization` header — a navigation, an image, an iframe, a download — still have to identify the visitor to whatever sits in front of this process.

### Expiry

`refreshMarginSeconds` before the token's `exp`, the gate acts. In this package that means sending the visitor back through the login page, which is the one renewal route every deployment has. `handleTokenExpiring` in `src/client/run.ts` is the single place that decision is made and the only reader of the margin: a deployment whose sign-on offers a renewal endpoint replaces that function's body, and nothing else in the gate depends on how a token is renewed.

### Giving the token up

Three decisions leave for the login page: a boot that found no usable token, a token another tab removed or let expire, and the expiry margin. All three run the same three steps, in this order.

1. **`POST /auth-gate/logout`**, so the node half stops spending a credential the visitor no longer has. The request is `keepalive`, because the navigation in step 3 would otherwise cancel a request the document owns.
2. **Clear the mirror cookie**, under the exact `Path`, `Secure`, and `SameSite` the mirror was written with — a browser matches a removal against an existing cookie by name, path, and domain, so a line differing in any of them writes a second, empty cookie and leaves the token in place. A dead token surviving here would go on being presented to the reverse proxy in front of this process on every request the login page itself makes.
3. **Navigate to the login page**, with `token` and `token4a` removed from the return address — from its query and from its fragment alike. Those are the parameters the deployment's login page reads a credential out of; handing one back would return the token this gate has just refused, through the browser's history and through every referrer the login page sends. The fragment is stripped as well because that page reads a parameter out of the whole address rather than out of its query — toy-core's `getUrlParam` parses everything past the first `?` in `location.href` — so removing only the query's would uncover the fragment's by taking away the `?` that was hiding it. The fragment's own route and its other parameters survive: these pages are hash-routed, so the fragment is the address.

That order rests on when the browser attaches cookies. Step 1's request reaches this process through the same reverse proxy, which routes it by the very mirror cookie step 2 removes a moment later, and the sequence holds because a browser attaches cookies when a fetch is initiated, which is what Chromium does. One that read them at send time instead would present none, the proxy would refuse the sign-out, and the only trace would be a warning in the console while the node half went on holding the token until the process ends.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/auth-gate/settings` | GET, HEAD | The three configured values the browser half must obey. `no-store`: the browser reads it once per boot and the values come from the row it booted with. |
| `/auth-gate/token` | POST | Takes the token the browser found. Answers 204 and no body. |
| `/auth-gate/logout` | POST | Drops the held token. Answers 204 and no body. |
| `/auth-gate/mcp/<name>` | any | Forwards to the upstream configured under `<name>`, with the held token attached. |

The token route is same-site and JSON-only: a request a browser labels `sec-fetch-site: cross-site` is refused 403 and one that does not declare `application/json` is refused 415, both before the body is read, so a cross-origin page cannot post a token as a preflight-free simple request. A body that is not a JSON document whose `token` field is a three-segment JWT is refused 400, and neither refusal quotes what was posted — a diagnostic naming a near-miss credential would put it wherever the response is read.

The sign-out route carries both halves of that fence and reads no body at all: it names no token, it drops whichever one is held, which is the token of the one visitor this process serves. A cross-origin page that could reach it could sign that visitor out of the deployment they are working in, and same-site alone would not stop one — a request carrying no `sec-fetch-site` header passes that check, so it is the `application/json` requirement that withdraws this route from the preflight-free simple set as well. The browser half declares the content type and posts no body.

The token is held in a closure inside the plugin and written nowhere: no session event, no settings document, no log line, no diagnostic. There is no route that reads it back, and the only route that changes it either replaces it with a newer one or drops it.

## Forwarding MCP requests with the token

`dsh-mcp-client` resolves its headers once, when its row loads. It has no way to attach a credential that arrives later and differs per signed-in person, which is exactly what an access token is. Each entry in `mcpUpstreams` closes that gap by claiming a local route; the MCP client row then points its `url` at that route instead of at the server:

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    loginUrl: /toy-proxy/toy-login/#/
    cookieName: accessToken
    refreshMarginSeconds: 300
    mcpUpstreams:
      crm: https://mcp.internal/crm

- id: mcp-crm
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: crm
    transport: streamable-http
    url: http://127.0.0.1:3080/auth-gate/mcp/crm
```

The port in that `url` must be the port this very process listens on: the route is this process's own, and a copied literal points every visitor's MCP calls at whichever process took that port — which is to say, at another person's held token. A deployment running one process per signed-in person reads it from the environment (`` url: !!js `http://127.0.0.1:${process.env.DSH_PORT}/auth-gate/mcp/crm` ``) rather than writing a number.

The forward rides on the dsh webserver's own route registry rather than a listener of its own. Its `WebRoute` handler owns the full response lifecycle, which is what an MCP streamable-HTTP exchange needs: a POST answered with either a JSON document or an event stream held open, and a GET held open for the server-to-client stream. Bytes are relayed in both directions rather than decoded, so an event stream arrives at the MCP client incrementally.

What the forward changes, and nothing else:

- **`Authorization` becomes the held token.** A caller's own credential is replaced rather than passed through, so nothing can smuggle one past the gate.
- **`Cookie` is dropped.** The mirror carries the very same token, and an upstream has no business receiving the browser's cookie jar.
- **Hop-by-hop headers and `Host` are dropped** in both directions; everything else the transport sends survives.
- **The path past the route prefix and the query string are carried** onto the target's own path.

While no browser has posted a token, every forwarding route answers 503 naming the upstream — the honest answer for a credential the process does not have yet. An upstream that cannot be reached is 502; one that drops mid-answer truncates the response, because the status was already sent.

## Composition

This package is in no shipped bundle. `overlay/auth-gate.patch.yml` inserts the row over any surface:

```yaml
- insert:
    - id: auth-gate
      name: '@deepseek-ai/dsh-experimental-auth-gate'
      config:
        loginUrl: /toy-proxy/toy-login/#/
        cookieName: accessToken
        refreshMarginSeconds: 300
        mcpUpstreams: {}
```

`dsh --profile web --patch <path>` applies it. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

Every configured value is required and validated at load: an empty `loginUrl` or one already carrying a query string, a `cookieName` that is not a bare cookie name, an upstream name that is not a plain route segment, and a target that is not an absolute HTTP(S) URL without query or fragment each fail the row rather than surfacing as a redirect to nowhere or a tool call that fails on first use.

`loginUrl` is a browser-side address, assigned as it stands: a deployment served under a path prefix writes that prefix into the value (`/console/toy-proxy/toy-login/#/`), because nothing resolves it against the deployment base. A login page kept outside the shell's prefix, as the example above does, stays valid and simply receives no mirror cookie — that cookie is scoped to the prefix.

## Model Experience

None, as this package registers no tool, prompt section, or result: it carries a credential between the browser, the process, and the MCP servers the process forwards to, all of which happens outside any model request, and the tools those servers publish are `dsh-mcp-client`'s model-facing contribution rather than this package's.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated; whether an MCP server's tool list moves between requests is that server's behavior under `dsh-mcp-client`'s contract.

## Known Limitations and Deferred Work

- **The gate does not run before the rest of the shell.** Browser rows are created together and activate on their own service waits, so an unauthenticated visitor may see the shell paint before the redirect happens. `dsh.client.immediately` gets this row's bundle bytes fetched in the first tier, which shortens that window but does not order activation; only a boot-stage seam in the client runtime would close it.
- **Expiry sends the visitor back through the login page.** There is no renewal call, so a token that runs out costs a full navigation even when the deployment's sign-on could have issued a new one silently. The seam for that is `handleTokenExpiring` and nothing else.
- **The forward is HTTP only.** There is no upgrade route, so an MCP server reached over WebSocket cannot be forwarded through it; streamable-HTTP and its event streams are what the route serves.
- **One token for the whole process.** The node half holds the newest token any browser posted. That matches the deployment this package is for — one process per signed-in person — and would be wrong for a process several people reach, where the last browser to load a page would decide whose credential every MCP call spends.
- **Only the gate's own three login decisions sign out.** `POST /auth-gate/logout` drops the held token, and nothing but the browser half's boot, storage-change, and expiry paths calls it — there is no sign-out control, and no interruption of whatever the agent loop is doing at the time. A visitor who closes the tab instead leaves the process holding the token until it ends or another browser posts a newer one.
- **A visitor carrying no token signs out too.** The boot decision takes that exit whether or not anything was stored — deliberately, because the node half may still hold the token of whoever loaded the page before — and behind a reverse proxy that request carries no mirror cookie, comes back 401, and leaves one harmless warning in the console.
- **A revocation is not undone.** The browser half hands the node half a token in one place — the boot or storage-change decision that armed the page — so a sign-out that arrives while a page is still running leaves that page's MCP forwarding answering 503 until it loads again, with nothing on screen saying so. Two things reach that state: a sign-out request that arrives late enough to drop a token posted after it, and a cross-origin page that gets past the route's fence. Closing it means either naming the token to drop in the request, so a late one cannot hit a newer credential, or re-posting the current token when the page is shown again.
- **The settings route assumes an HTTP carrier.** The browser half fetches `/auth-gate/settings` — the root-absolute route the node half registers, resolved against the page's deployment base — so a transport that serves the shell without exposing the harness over HTTP would fail the row.
- **Not covered by an assembled snapshot** — the browser evidence is the Playwright scenario in `apps/web/tests/auth-gate.e2e.ts` against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
