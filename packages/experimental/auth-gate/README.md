---
description: "A deployment's own single sign-on wired into a dsh browser session: the browser half redirects an unauthenticated visitor to the login page and mirrors the returned access token into a cookie, the node half spends it on forwarded MCP requests; for deployments running one dsh process per signed-in person behind a token-verifying proxy."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-auth-gate

English | [中文](README.zh.md)

## Summary

A deployment's own single sign-on, wired into a dsh browser session. The browser half sends a visitor without an access token to the deployment's login page and mirrors the one it comes back with into a cookie; the node half holds that token in memory and spends it on the MCP servers this deployment forwards to. Nothing here issues or verifies a token — this package carries one that already exists to the two places dsh needs it, and, where the deployment publishes a renewal endpoint, spends that token on it to keep the visitor signed in without a trip through the login page.

It exists for one deployment shape: a reverse proxy in front of many dsh processes, one per signed-in person, choosing which process a request reaches by verifying the visitor's token itself. That proxy has already decided who is on the other end by the time a request arrives, which is why nothing inside the process checks a signature.

## Table of Contents

- [What the gate does on every page load](#what-the-gate-does-on-every-page-load)
- [Routes](#routes)
- [Forwarding MCP requests with the token](#forwarding-mcp-requests-with-the-token)
- [Reading the deployment's data backend](#reading-the-deployments-data-backend)
- [Composition](#composition)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-the-gate-does-on-every-page-load"></a>
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

### Expiry and renewal

Which of the two things the gate does about a coming expiry is `renewalPath`'s to decide. Left out, `refreshMarginSeconds` before the token's `exp` the gate sends the visitor back through the login page, which is the one renewal route every deployment has. Set, the gate asks that endpoint for a new token instead, and the visitor stays where they are.

A configured renewal runs on two schedules, both armed from the moment a token is accepted and re-armed every time one is. `renewalIntervalSeconds` after that moment, the gate asks for a new token and says nothing about it either way — the deployment's own client renews on the same rule, when the token it holds is older than `accessTokenRenewalTime` minutes, and this is that rule as a timer rather than as a check on the next request. The expiry margin asks as well, and it is the one that acts on a refusal: a margin no renewal answered gives the token up and leaves for the login page, exactly as a deployment with no renewal endpoint always does. A failed periodic attempt is silent, because the token in hand is still usable and the next tick asks again. Each margin answers for the token it was armed with and gives up no other: an exchange takes time, and a token that arrives while one is out — another tab's, an embedded deployment page's, this visitor signing in again — arms a margin of its own, so a failure at the old one says nothing about the credential the page now holds.

One exchange at a time, and the margin waits for a periodic attempt already out rather than starting a second one or leaving while an answer to the first is still coming. A token already past `exp` is never sent — the endpoint refuses a dead one, and that case ends at the margin. Nothing is stored until the mirror cookie carries the new token, so the cookie the reverse proxy reads and the value in storage never disagree. A storage write the browser refuses outright — a private window given no quota, a quota already full — counts as a renewal that produced nothing, the way a mirror cookie it did not keep already does.

An answer is taken only where its `exp` is later than two others. Later than the token the request was sent with, because an endpoint answering with the token it was given renews nothing while the margin re-arms with no delay and asks it again in the same tick, without end; such an answer counts as a refusal, so a periodic tick stays silent and a margin leaves for the login page. And later than whatever storage holds when the answer arrives, because every tab renews on its own schedule and a slow answer must not replace a newer token another tab has already stored. A renewal that is taken and is itself already inside the margin ends at the login page for the same reason: its own margin is armed with no delay, and renewing from there again would repeat for as long as the endpoint kept answering. A deployment whose `renewalIntervalSeconds` leaves no room ahead of its `refreshMarginSeconds` therefore signs the visitor out rather than renewing in a loop.

`GET <renewalPath>` goes to this page's own origin with the headers the deployment's own client sends for an authenticated request: the stored token verbatim, scheme included, on both `Authorization` and `CertificationToken`; whatever headers `localStorage.loginUserInfo` holds under them; and a fresh `TINY-REQUEST-ID` over all of it. The answer's `token` field is stored the way that deployment's `setToken` stores it — under `accessToken`, exactly as the answer carried it, with `accessTokenTime` written beside it — so the existing storage-to-cookie-to-node-half path carries the new token to the node half and to any deployment page embedded on the same origin. That timestamp is an ISO 8601 instant in UTC rather than the local-offset rendering `dayjs().format()` gives the same instant: the deployment's only reader of it, `isTokenRenewal`, takes a difference, and this rendering does not change with the timezone the browser happens to be in. An answer that carries no token, or one this gate cannot run on, changes nothing.

What a real deployment answered has been measured, and it was not a renewal. On the acceptance console on 2026-09-07, configured with `renewalPath: /nrms-auth/api/renewal` and `renewalIntervalSeconds: 120`, the browser half made 18 renewal attempts over the 36 minutes after the visitor signed in. That run was made on `71862aabc0` — this change before it carried the rule above — which took each answer and posted it to `/auth-gate/token`. Two instruments read it, both from inside the page. The `jti` and `exp` equality is what the first one shows: the claims of the token in storage were decoded in the page after each tick, so the value never left it, and comparing them across ticks left both unchanged — which, on a build that stored every answer, is an endpoint answering with the token it had been sent. What the second one reports is the four renewal requests at 120, 240, 360 and 480 seconds: each answered 200, and on that build each was followed by a `POST /auth-gate/token` that answered 204, both statuses read from the page's own `PerformanceResourceTiming.responseStatus`. Under the shipped rule an answer that does not move the expiry is a failed renewal, so on this build the periodic schedule stores nothing and posts nothing, and the margin gives the token up and leaves for the login page exactly as it does for a deployment that publishes no endpoint at all. What the measurement settles is that the endpoint accepts the headers this package sends. What it answers nearer the expiry was measured the same way, by hand and on the same day: 2.3 minutes before that token's `exp`, `GET /nrms-auth/api/renewal` answered HTTP 200 with the same JWT again — same `jti`, same `exp` — in a body of two keys, `renewal` holding the string `"3600000"` and `token` holding that JWT. 100 seconds after the `exp`, the same request answered HTTP 401 with an empty body, and so did a metadata read, `GET /nrms-schema-manage/api/meta/resclass/SpaceLayer`, made with that token. Both were fetches issued from the page carrying the stored token's headers, with the answers' claims decoded in the page, so no token value left it. On this deployment, then, the JWT's `exp` is the real expiry and this endpoint issues no fresh token before it or after it. The two renewal fields therefore stay unconfigured there, and that console keeps the margin-to-login path it already had. What the feature is for is a deployment whose endpoint answers with a later `exp`.

### Giving the token up

Three decisions leave for the login page: a boot that found no usable token, a token another tab removed or let expire, and an expiry margin no renewal answered. All three run the same three steps, in this order.

Before the first of them, a running gate releases itself: the storage subscription, the expiry margin, and the periodic renewal all stop, and any renewal still out is aborted. Without that, a periodic timer already dequeued when the decision was taken would go on to renew during the navigation and write the token back into storage, into the mirror cookie, and into the node half, for a visitor who has just given it up.

A fourth decision releases the gate the same way without leaving for the login page: a `storage` change naming a different `sub` reloads the page, and a renewal still out for the previous account would otherwise land while the browser is tearing the document down, writing that account's token into those same three places for the document coming up to boot on.

1. **`POST /auth-gate/logout`**, so the node half stops spending a credential the visitor no longer has. The request is `keepalive`, because the navigation in step 3 would otherwise cancel a request the document owns.
2. **Clear the mirror cookie**, under the exact `Path`, `Secure`, and `SameSite` the mirror was written with — a browser matches a removal against an existing cookie by name, path, and domain, so a line differing in any of them writes a second, empty cookie and leaves the token in place. A dead token surviving here would go on being presented to the reverse proxy in front of this process on every request the login page itself makes.
3. **Navigate to the login page**, with `token` and `token4a` removed from the return address — from its query and from its fragment alike. Those are the parameters the deployment's login page reads a credential out of; handing one back would return the token this gate has just refused, through the browser's history and through every referrer the login page sends. The fragment is stripped as well because that page reads a parameter out of the whole address rather than out of its query — toy-core's `getUrlParam` parses everything past the first `?` in `location.href` — so removing only the query's would uncover the fragment's by taking away the `?` that was hiding it. The fragment's own route and its other parameters survive: these pages are hash-routed, so the fragment is the address.

That order rests on when the browser attaches cookies. Step 1's request reaches this process through the same reverse proxy, which routes it by the very mirror cookie step 2 removes a moment later, and the sequence holds because a browser attaches cookies when a fetch is initiated, which is what Chromium does. One that read them at send time instead would present none, the proxy would refuse the sign-out, and the only trace would be a warning in the console while the node half went on holding the token until the process ends.

<a id="routes"></a>
## Routes

| Route | Method | Purpose |
|---|---|---|
| `/auth-gate/settings` | GET, HEAD | The configured values the browser half must obey, the renewal endpoint among them where one is configured. `no-store`: the browser reads it once per boot and the values come from the row it booted with. |
| `/auth-gate/token` | POST | Takes the token the browser found. Answers 204 and no body. |
| `/auth-gate/logout` | POST | Drops the held token. Answers 204 and no body. |
| `/auth-gate/mcp/<name>` | any | Forwards to the upstream configured under `<name>`, with the held token attached. |

The token route is same-site and JSON-only: a request a browser labels `sec-fetch-site: cross-site` is refused 403 and one that does not declare `application/json` is refused 415, both before the body is read, so a cross-origin page cannot post a token as a preflight-free simple request. A body that is not a JSON document whose `token` field is a three-segment JWT is refused 400, and neither refusal quotes what was posted — a diagnostic naming a near-miss credential would put it wherever the response is read.

The sign-out route carries both halves of that fence and reads no body at all: it names no token, it drops whichever one is held, which is the token of the one visitor this process serves. A cross-origin page that could reach it could sign that visitor out of the deployment they are working in, and same-site alone would not stop one — a request carrying no `sec-fetch-site` header passes that check, so it is the `application/json` requirement that withdraws this route from the preflight-free simple set as well. The browser half declares the content type and posts no body.

The token is held in a closure inside the plugin and written nowhere: no session event, no settings document, no log line, no diagnostic. There is no route that reads it back, and the only route that changes it either replaces it with a newer one or drops it.

<a id="forwarding-mcp-requests-with-the-token"></a>
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

<a id="reading-the-deployments-data-backend"></a>
## Reading the deployment's data backend

The deployment that issues the token also serves its own data. `bizUpstream` gives this process the base those requests are built onto, and the gate constructs [`dsh-experimental-biz-backend`](../biz-backend/README.md)'s `ctx.bizBackend` over it, with the token it already holds. That package owns the reads, what they put on the wire, and how every answer is classified.

```yaml
- id: auth-gate
  name: '@deepseek-ai/dsh-experimental-auth-gate'
  config:
    loginUrl: /toy-proxy/toy-login/#/
    cookieName: accessToken
    refreshMarginSeconds: 300
    mcpUpstreams: {}
    bizUpstream: https://<host>/ini-server/
```

`bizUpstream` must be an absolute `http(s)` address with no query string, fragment, or credentials of its own, and a path ending in `/`. That path is the deployment's API prefix, which is the frontend's own `VUE_APP_BASE_URL`: a standard install builds `/ini-server/`, and an install built without one publishes at the origin root. There is no default. A value left out means this deployment offers no data backend, so `bizBackend` is not constructed at all and a row consuming it stays pending with the missing service named — rather than installing one whose every read fails.

The token reaches those reads the same way it reaches a forward: by reference, as the closure this package holds it in. The reads spend it on both the `Authorization` and `CertificationToken` headers, and give it up through the same closure when the backend refuses it — which is this package's own sign-out state, and what the limitations below record.

-----

<a id="composition"></a>
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

Every configured value is validated at load, and every one but `bizUpstream`, `renewalPath`, and `renewalIntervalSeconds` is required: an empty `loginUrl` or one already carrying a query string, a `cookieName` that is not a bare cookie name, an upstream name that is not a plain route segment, a target that is not an absolute HTTP(S) URL without query or fragment, and an unusable `bizUpstream` each fail the row rather than surfacing as a redirect to nowhere, a tool call that fails on first use, or a credential sent to the wrong address. A refused address is quoted back with any user name and password written into it removed, and a value the URL parser could not read at all is not quoted back at all — such a value can carry a password no check here recognizes, and a load failure is read wherever this row's output goes.

The two renewal fields are refused in halves, and the path is refused unless it is a path on this deployment's own origin: an interval with no path is a deployment that believes it renews and does not, a path with no interval renews on no schedule, and a path naming another origin — or a protocol-relative `//host/path`, which names one without looking like it — would send this visitor's credential off the deployment. An interval of zero is refused too, and so is one above 2147483 seconds, which is as long as a single browser timer carries: a longer wait is slept in links of that length where the gate has no choice — an expiry margin's delay is whatever `exp` the token holds — but an interval that long is a number no deployment means, naming a schedule that first fires 24 days out, which no token this gate accepts lives to reach. The browser half checks the same three things again on the document it is served, because that document crossed a process.

`loginUrl` is a browser-side address, assigned as it stands: a deployment served under a path prefix writes that prefix into the value (`/console/toy-proxy/toy-login/#/`), because nothing resolves it against the deployment base. A login page kept outside the shell's prefix, as the example above does, stays valid and simply receives no mirror cookie — that cookie is scoped to the prefix.

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or result: it carries a credential between the browser, the process, and the MCP servers the process forwards to, all of which happens outside any model request, and the tools those servers publish are `dsh-mcp-client`'s model-facing contribution rather than this package's.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated; whether an MCP server's tool list moves between requests is that server's behavior under `dsh-mcp-client`'s contract.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The gate does not run before the rest of the shell.** Browser rows are created together and activate on their own service waits, so an unauthenticated visitor may see the shell paint before the redirect happens. `dsh.client.immediately` gets this row's bundle bytes fetched in the first tier, which shortens that window but does not order activation; only a boot-stage seam in the client runtime would close it.
- **A deployment that configures no `renewalPath` still signs the visitor out at the margin.** The renewal is opt-in per deployment, because where the endpoint lives is deployment-specific and there is nothing to guess; without one, a token that runs out costs a full trip through the login page even when the sign-on behind it could have issued a new one silently.
- **Every open tab renews on its own.** The gate has no leader election and no lock, so two tabs of the same console each ask the endpoint every `renewalIntervalSeconds`, and each writes what it gets. They converge — the tab that did not ask sees the other's write as a same-person `storage` change and takes the newer token through the path that already existed — but the deployment sees one exchange per tab rather than one per person, and the last write wins where two answers cross. Closing it means a lock the gate would have to acquire (the Web Locks API is the obvious one) and a tab that renews on behalf of the others.
- **A failed periodic renewal says nothing.** Nothing on screen, nothing in the console, nothing in the node half: a deployment whose renewal endpoint has been refusing for hours looks exactly like one that has not, until the expiry margin arrives and the visitor is sent to the login page. The alternative — reporting an attempt that the next tick may well recover from — is noise on every transient failure.
- **The deployment this was written for issues no fresh token, which leaves the renewal inert there.** Every answer it gave carried back the token that was sent, the one asked for 2.3 minutes before `exp` included, and 100 seconds after `exp` both that endpoint and a metadata read answered 401: its JWT `exp` is the real expiry. The two fields stay unconfigured on that console, which therefore keeps the margin-to-login path it already had, and this package buys it nothing the old behavior did not. Every endpoint these tests answer from is a fake; a deployment whose endpoint answers with a later `exp` is what would show the renewal working end to end.
- **A deployment that sets `isAuth` is not gated at all.** `toy-core` switches every token key to `accessTokenAuth` and `accessTokenTimeAuth` when `getLocalConfig().isAuth` is set, and both halves of this package name the default keys only. Under such a deployment the gate reads a key that deployment's login page never writes, so a visitor is sent to the login page, signed in, and sent there again; nothing configures the key names, and nothing reports the mismatch.
- **The forward is HTTP only.** There is no upgrade route, so an MCP server reached over WebSocket cannot be forwarded through it; streamable-HTTP and its event streams are what the route serves.
- **One token for the whole process.** The node half holds the newest token any browser posted. That matches the deployment this package is for — one process per signed-in person — and would be wrong for a process several people reach, where the last browser to load a page would decide whose credential every MCP call spends.
- **Only the gate's own three login decisions sign out.** `POST /auth-gate/logout` drops the held token, and nothing but the browser half's boot, storage-change, and expiry paths calls it — there is no sign-out control, and no interruption of whatever the agent loop is doing at the time. A visitor who closes the tab instead leaves the process holding the token until it ends or another browser posts a newer one.
- **A visitor carrying no token signs out too.** The boot decision takes that exit whether or not anything was stored — deliberately, because the node half may still hold the token of whoever loaded the page before — and behind a reverse proxy that request carries no mirror cookie, comes back 401, and leaves one harmless warning in the console.
- **A revocation is not undone.** The browser half hands the node half a token in one place — the boot or storage-change decision that armed the page — so a sign-out that arrives while a page is still running leaves that page's MCP forwarding answering 503 until it loads again, with nothing on screen saying so. Two things reach that state: a sign-out request that arrives late enough to drop a token posted after it, and a cross-origin page that gets past the route's fence. Closing it means either naming the token to drop in the request, so a late one cannot hit a newer credential, or re-posting the current token when the page is shown again.
- **A refused token is not a reason to leave.** The browser half decides on shape and expiry alone — what it leaves for is a stored value that is not a JWT with an `exp` still ahead — so a token an outer gate refuses while it is still unexpired (revoked, signed with a rotated key, an account since disabled) reads as usable here. The shell paints, every gated call behind it fails, and nothing sends the visitor anywhere; the expiry schedule is the only exit this package has, and it fires at the margin before `exp` rather than when the refusal starts. Treating a 401 from this package's own calls as a fourth reason to leave for the login page is the missing half, and it belongs beside the three decisions in `src/client/run.ts` that already do.
- **The sign-out order assumes the mirror cookie still opens the proxy.** Step 1's post reaches this process only while the reverse proxy accepts the cookie it carries, and a proxy that validates that cookie rather than only routing by it — a site gate asking the deployment's own authentication service, as `dsh-experimental-server-base`'s nginx sample does — refuses the post on exactly the paths that surrender a token it will not accept: one already past `exp`, and one refused upstream while unexpired. The node half then holds the dead token until the process ends or a newer one is posted. Steps 2 and 3 run regardless, so the visitor still leaves; what stays is process-side.
- **A read the backend refuses stops MCP forwarding as well.** HTTP 401 or 403 from the data backend makes the process give up the token, which is the sign-out route's terminal state, so every forwarding route answers 503 from then on and every read answers `unauthenticated` — until some browser posts a new token. One read's failure is therefore process-wide rather than local to that read.
- **The process then knows something the page does not.** The node half is the first place in this process to learn that the token it holds was refused, and it has no channel for telling the browser: that page runs on until its own expiry schedule fires. Closing it means a fourth departure decision beside the three in `src/client/run.ts` — the token route answering 409 once the credential was dropped as refused is the cheapest form.
- **Nothing reads the reason a credential was dropped.** `HeldCredential.drop` takes `'sign-out'` or `'refused-by-backend'`, both call sites pass the true one, and both reach the same terminal state; the closure reads neither. The parameter exists for the departure decision above, whose 409 answer has to tell the two apart, and it has no reader until that lands.
- **`Bearer ` is added back.** The gate holds the bare JWT, and both data-backend headers get the scheme put back on, on the premise that this deployment's login page stores `"Bearer <jwt>"` — the contract `src/client/browser.ts` states. A deployment whose login page stores a bare JWT receives one scheme more than its own page sends.
- **The settings route assumes an HTTP carrier.** The browser half fetches `/auth-gate/settings` — the root-absolute route the node half registers, resolved against the page's deployment base — so a transport that serves the shell without exposing the harness over HTTP would fail the row.
- **Not covered by an assembled snapshot** — the browser evidence is the Playwright scenario in `apps/web/tests/auth-gate.e2e.ts` against a real composition, renewal included; the snapshot lanes replay the shipped composition, which does not compose an experimental row.

**Runtime invariant:** No companion is published. This package appends no session event and owns no durable data. The one piece of mutable state it does own — the held access token — is deliberately unreachable from anywhere but the plugin closure that holds it, because a reader an invariant could use would be a reader an attacker could use; the token route's own parse enforces its shape where it enters.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
