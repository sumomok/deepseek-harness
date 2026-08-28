# @deepseek-ai/dsh-experimental-auth-gate

English | [中文](README.zh.md)

A deployment's own single sign-on, wired into a dsh browser session. The browser half sends a visitor without an access token to the deployment's login page and mirrors the one it comes back with into a cookie; the node half holds that token in memory and spends it on the MCP servers this deployment forwards to. Nothing here issues, verifies, or renews a token — this package carries one that already exists to the two places dsh needs it.

It exists for one deployment shape: a reverse proxy in front of many dsh processes, one per signed-in person, choosing which process a request reaches by verifying the visitor's token itself. That proxy has already decided who is on the other end by the time a request arrives, which is why nothing inside the process checks a signature.

## What the gate does on every page load

1. Read this plugin's browser-facing configuration from `/auth-gate/settings`. A browser half receives no cordis config — the boot manifest carries plugin names, not their `config` blocks — so an unreachable or unusable settings document fails the row rather than letting the gate run on a login address nobody chose.
2. Read `localStorage.accessToken`. The key is fixed rather than configured: it is the key the deployment's login page writes, so it is a contract with that page rather than a choice this plugin makes.
3. **No token, an unreadable one, one with no `exp`, or one already past it** — leave for `<loginUrl>?redirect=<the encoded current URL>`. A token without `exp` is refused rather than treated as eternal, because the gate's whole schedule is built on that claim.
4. **A usable token the cookie does not carry** — write the cookie, then load the page again so the request that follows already carries it.
5. **A usable token the cookie already carries** — run the page, and `POST /auth-gate/token` so the node half can spend it.

While the page runs, a `storage` event — another tab signing in, out, or renewing — is re-read from storage rather than trusted from the event. The same person with a newer token gets the cookie updated and the node half told, with no reload. A different `sub` reloads the whole page, because everything on screen was fetched as somebody else. A token that is gone or expired sends the visitor back to the login page.

### The mirror never loops

This is the failure the design is shaped around: a boot that decides to mirror ends in a reload, and if that reload decided to mirror again, the tab would never do anything else.

The guard is structural rather than a counter. A mirror writes the cookie, **reads it back**, and reloads only when the read-back shows the token. A write that did not take — the page is on plain HTTP, or cookies are blocked for the origin — fails the row with a diagnostic naming the cookie, and no reload happens at all. The reload that does happen finds the cookie in step and takes the `ready` path, which reloads nothing. Neither the token nor any part of it appears in that diagnostic.

### Why the mirror cookie is not `HttpOnly`

The token already lives in `localStorage`, where the deployment's login page put it and where any script on the page can read it. A cookie the page's own script could not read would narrow no attack surface — an injected script would simply read the original — while making the mirror impossible to keep in step with it. `Secure` and `SameSite=Lax` do still apply: the first keeps the cookie off plaintext hops, the second keeps it off cross-site subrequests.

The cookie exists because requests that carry no `Authorization` header — a navigation, an image, an iframe, a download — still have to identify the visitor to whatever sits in front of this process.

### Expiry

`refreshMarginSeconds` before the token's `exp`, the gate acts. In this package that means sending the visitor back through the login page, which is the one renewal route every deployment has. `handleTokenExpiring` in `src/client/run.ts` is the single place that decision is made and the only reader of the margin: a deployment whose sign-on offers a renewal endpoint replaces that function's body, and nothing else in the gate depends on how a token is renewed.

## Routes

| Route | Method | Purpose |
|---|---|---|
| `/auth-gate/settings` | GET, HEAD | The three configured values the browser half must obey. `no-store`: the browser reads it once per boot and the values come from the row it booted with. |
| `/auth-gate/token` | POST | Takes the token the browser found. Answers 204 and no body. |
| `/auth-gate/mcp/<name>` | any | Forwards to the upstream configured under `<name>`, with the held token attached. |

The token route is same-site and JSON-only: a request a browser labels `sec-fetch-site: cross-site` is refused 403 and one that does not declare `application/json` is refused 415, both before the body is read, so a cross-origin page cannot post a token as a preflight-free simple request. A body that is not a JSON document whose `token` field is a three-segment JWT is refused 400, and neither refusal quotes what was posted — a diagnostic naming a near-miss credential would put it wherever the response is read.

The token is held in a closure inside the plugin, for the process lifetime, and written nowhere: no session event, no settings document, no log line, no diagnostic. There is no route that reads it back.

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

## Model Experience

None, as this package registers no tool, prompt section, or result: it carries a credential between the browser, the process, and the MCP servers the process forwards to, all of which happens outside any model request, and the tools those servers publish are `dsh-mcp-client`'s model-facing contribution rather than this package's.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated; whether an MCP server's tool list moves between requests is that server's behavior under `dsh-mcp-client`'s contract.

## Known Limitations and Deferred Work

- **The gate does not run before the rest of the shell.** Browser rows are created together and activate on their own service waits, so an unauthenticated visitor may see the shell paint before the redirect happens. `dsh.client.immediately` gets this row's bundle bytes fetched in the first tier, which shortens that window but does not order activation; only a boot-stage seam in the client runtime would close it.
- **Expiry sends the visitor back through the login page.** There is no renewal call, so a token that runs out costs a full navigation even when the deployment's sign-on could have issued a new one silently. The seam for that is `handleTokenExpiring` and nothing else.
- **The forward is HTTP only.** There is no upgrade route, so an MCP server reached over WebSocket cannot be forwarded through it; streamable-HTTP and its event streams are what the route serves.
- **One token for the whole process.** The node half holds the newest token any browser posted. That matches the deployment this package is for — one process per signed-in person — and would be wrong for a process several people reach, where the last browser to load a page would decide whose credential every MCP call spends.
- **Nothing revokes the held token.** There is no route that clears it, and a browser signing out leaves the process holding the token it last posted until the process ends or another browser posts a newer one.
- **The settings route assumes an HTTP carrier.** The browser half fetches `/auth-gate/settings` relative to the page origin, so a transport that serves the shell without exposing the harness over HTTP would fail the row.
- **Not covered by an assembled snapshot** — the browser evidence is the Playwright scenario in `apps/web/tests/auth-gate.e2e.ts` against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
