# Agent Note: browser single sign-on and MCP token injection

Status: implemented

English | [中文](2026-08-28-browser-single-sign-on-and-mcp-token-injection.zh.md)

## Problem

A dsh Web surface behind an organization's own single sign-on has three gaps, and none of the existing seams closes any of them.

The shell has no notion of a signed-in person. `dsh-client-connection` fences `/api` on reachability — loopback, declared hosts, Fetch-Metadata markers — and its own README says so: "The fence is a reachability policy, not authentication; the Web carrier provides no authentication layer." A deployment that puts a reverse proxy in front and routes each signed-in person to their own dsh process therefore has an authenticated edge and an unauthenticated interior, with nothing carrying the identity across.

The proxy needs the token on every request, including the ones a browser sends without any script involvement — the initial navigation, an image, an iframe, a download. Those carry cookies and nothing else. The token the organization's login page issues lives in `localStorage`, which no such request touches.

An MCP server behind the same sign-on wants the visitor's bearer token, and `dsh-mcp-client` resolves its `headers` config once when its row loads. A credential that arrives after boot and differs per signed-in person cannot be expressed there at all: `headers: { Authorization: !!js ... }` is evaluated at load, against the process environment, before any browser has connected.

## Decision

One experimental package, `packages/experimental/auth-gate`, with both halves.

The browser half is a boot module with no slot, no component, and no copy. On every page load it reads its configuration from the node half's settings route, reads `localStorage.accessToken`, and takes one of three paths: no usable token leaves for `<loginUrl>?redirect=<encoded current URL>`; a usable token the cookie does not carry is mirrored into that cookie and the page loaded again; a usable token the cookie already carries runs the page and is posted to the node half.

The node half serves those settings, takes the posted token into a closure, and claims one forwarding route per configured MCP upstream. A forward relays bytes in both directions with `Authorization: Bearer <held token>` replacing whatever the caller sent.

### The token is accepted on shape alone

Neither half verifies a signature. The party that can is the reverse proxy, which verifies the token to decide which dsh process the request reaches — so by the time a request arrives, the question "who is this" has already been answered by something with the key. A second check inside the process would validate the claims it was handed against a key it was handed.

What the token buys inside the process is bounded accordingly: it reaches the MCP servers this deployment configured, as the person the proxy already routed here. There is no route that reads the token back, and it is written to no session event, settings document, log line, or diagnostic. The refusals name the field, never the value: a message quoting a near-miss credential would deposit it wherever the response is read.

### The cookie mirror is not `HttpOnly`, and that costs nothing

The token already lives in `localStorage`, where the login page put it and where any script on the page reads it. A cookie the page's own script could not read would narrow no attack surface — an injected script reads the original — while making the mirror impossible to keep in step. `Secure` and `SameSite=Lax` still apply.

### The mirror cannot loop

A boot that mirrors ends in a reload; a reload that decided to mirror again would spin the tab forever. The guard is structural rather than a counter: the mirror writes the cookie, reads it back, and reloads only when the read-back shows the token. A write that did not take — plain HTTP, blocked cookies — fails the row with a diagnostic naming the cookie, and reloads nothing. Because the guard is a property of the state rather than of a count, it also holds across tabs, across restores, and across a token replaced between the write and the reload.

### Expiry is a navigation, with one named seam

`refreshMarginSeconds` before `exp`, the gate acts, and acting means sending the visitor back through the login page — the one renewal route every deployment has. `handleTokenExpiring` in `src/client/run.ts` is the single place that decision is made and the only reader of the margin. A deployment whose sign-on gains a renewal endpoint replaces that function's body; nothing else in the gate depends on how a token is renewed. A token carrying no `exp` is refused rather than treated as eternal, because that claim is what the whole schedule is built on.

### The forward rides the dsh webserver

`WebServer.register` documents that a route handler "Owns the full response lifecycle (may hold the response open, e.g. SSE)", and the service never reads a request body on the handler's behalf. That is exactly the streamable-HTTP exchange an MCP client performs: a POST answered with either a JSON document or an event stream held open, a GET held open for the server-to-client stream, and a DELETE ending the session. Relaying `node:http` streams in both directions keeps the answer incremental, which `apps/web/tests/auth-gate.e2e.ts` and the package's route suite both observe.

A second listener would have bought nothing and cost several things: another port in `Config` and in the deployment's proxy map, a second lifecycle to tie to the fiber, and a second surface for the same-site fence to be applied to — while the token would still live in this process either way.

The forward replaces `Authorization` rather than passing one through, so nothing smuggles a credential past the gate, and drops `Cookie`, because the mirror carries the very same token and an upstream has no business receiving the browser's jar.

## Alternatives considered

**Verify the JWT signature in the node half.** It would need the issuer's key as configuration, key rotation handling, and a clock-skew policy — to re-derive a decision the proxy already made with the same key, one hop earlier. It would also change nothing about what the token can do here, because reaching this process at all already required passing the proxy. Rejected as duplicated authority.

**Put the token in `dsh-mcp-client` rather than proxying.** The natural shape — a `headers` value resolved per request — is a change to a shipped package's config contract for one experimental deployment's benefit, and it would have to reach across packages for a credential `dsh-mcp-client` has no seam to receive. The local forwarding route keeps the whole mechanism inside this package and leaves `dsh-mcp-client` configured exactly as it already documents, with a `url` that happens to be local.

**Its own `node:http` listener for the forward.** Considered because it is independent of whatever the webserver supports. Rejected once the `WebRoute` contract turned out to already promise the one property that mattered — the handler owning an open response — leaving the listener with only costs: a configured port, a second entry in the deployment's proxy map, a second lifecycle owner for the same asynchronous surface, and a fence to duplicate.

**An `HttpOnly` mirror cookie.** Rejected on the arithmetic above: the token is readable from `localStorage` by anything that could have read the cookie, so `HttpOnly` removes no capability from an attacker while removing the gate's ability to keep the two in step.

**A reload counter, or a `sessionStorage` "already tried" flag, as the loop guard.** Both make the guard a property of a count rather than of the state, so both are wrong after a restore, in a second tab, or when the token is replaced between the write and the reload — and both would let a genuinely failing cookie write reload once before giving up. Reading the cookie back tests the exact condition the next boot will test.

**Silent renewal at the margin.** Rejected as speculative for v1: no renewal endpoint exists to call, so the code would be a shape without a consumer. The named seam records where it goes.

**Making the gate a `packages/client/*` package.** Rejected: it is a deployment-specific integration with an organization's sign-on, not part of the shipped web stack, and `packages/experimental` is where such rows live until a deployment proves them.

## Consequences

A dsh process behind this row has an identity for the browser looking at it, and MCP servers behind the same sign-on become reachable with that identity — neither of which was expressible before.

The gate does not run before the rest of the shell. Browser rows are created together and activate on their own service waits, so an unauthenticated visitor may see the shell paint before the redirect. `dsh.client.immediately` fetches this row's bundle in the first prefetch tier, which shortens the window without ordering activation; closing it needs a boot-stage seam in the client runtime that does not exist.

One token serves the whole process — the newest any browser posted. That matches the deployment this package is for and would be wrong for a process several people reach, where the last browser to load a page would decide whose credential every MCP call spends. Nothing revokes it either: a browser signing out leaves the process holding what it last posted.

The row is experimental and in no shipped bundle, so no release composition changes and no other e2e scenario sees it. Its own coverage is the package's three suites plus `apps/web/tests/auth-gate.e2e.ts`, which drives the whole round trip — redirect, stub login page, return, mirror, the single reload, and an MCP request reaching a fixture upstream with the browser's token on it.
