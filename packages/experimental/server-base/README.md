---
description: "Tells the browser whether reaching a served dsh page means owning the Host behind it, by injecting a `__DSH_TRANSPORT__` carrier that declares `ownsHost` into the shell's index where the deployment claims the Host; also carries the nginx sample for a console published under a path prefix behind a login gate, and the login-gate proxy and verifier that sign the member identity assertion dsh receives."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-server-base

English | [中文](README.zh.md)

## Summary

Tells the browser whether reaching the served page means owning the Host behind it. The client decides that from the page authority alone, and every authority that is not loopback reads as somebody else's Host — which is the deployment this package exists for: a console published on a public name, behind a proxy that decides who reaches it.

## Table of Contents

- [What it injects](#what-it-injects)
- [Configuration](#configuration)
- [Claiming the Host](#claiming-the-host)
- [Composition](#composition)
- [The proxy half](#the-proxy-half)
- [The deploy proxy and verifier](#deploy-proxy)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="what-it-injects"></a>
## What it injects

It exists for the deployment that cannot have a hostname of its own: several products behind one domain, dsh among them, separated by path. The prefix itself needs nothing from this package — the served index carries `<base href="./">`, so a page loaded under a prefix-stripping proxy keeps every URL it builds under that mount — and [the proxy half](#the-proxy-half) is the matching nginx sample.

One row on `webserver/index-inject`, and only where `ownsHost` is set: `<script>globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };</script>`. `__DSH_TRANSPORT__` is the carrier `client-connection` reads once, at its own plugin boot, and the served page normally leaves unset; the shell that does set one — the worker preview, whose Host runs in a worker it spawned — assembles a physical transport there, which is why the row assigns with `??=` rather than over it. This row's carrier is not a transport at all: its `fetch` is the page's own, the same caller that plugin uses when the global is absent, and it declares no `openStream` and no `loadBundle`, so the RPC keeps its HTTP requests and its Gateway WebSocket and the plugin bundles keep loading over HTTP. `ownsHost` is the one fact it carries.

The listener is registered with `prepend`, so the row renders ahead of every document script and of rows a listener registered earlier contributed.

<a id="configuration"></a>
## Configuration

`ownsHost` is a boolean, `false` unless the deployment writes it, and a value of any other type fails the row rather than being read for its truthiness. Left out, the row contributes nothing and the served index is the dist server's own.

<a id="claiming-the-host"></a>
## Claiming the Host

The client keeps part of its surface for the operator's own machine and decides who that is from the page authority: `ctx.connection.isLoopback`. Off loopback, settings run on a process-local mirror that answers every read `unavailable` — so every settings section, the MCP servers among them, says it cannot read settings — the settings document actions do not appear, and a produced-file chip does not offer to open its path on the Host.

`ownsHost` says that decision is wrong for this deployment: whoever reaches the served page is this Host's operator. Nothing else supplies that fact, because the authority is a public one and the page cannot tell a gate from an open door.

**What it is a claim about is the gate in front of the page, not the visitor.** Set it only where something decides who reaches the page — this deployment pairs the dsh browser session cookie with the proxy's `auth_request` login gate, described in [the proxy half](#the-proxy-half) — because every visitor those admit gets that surface, and they all share the one Host behind it. One part of that surface reaches past the browser: the settings document action asks the Host to materialize its settings file on disk and open it in a native text editor, so on a headless console it launches an editor process on the server.

**It moves no server-side check.** The `/api` browser-trust fence still refuses a Host that is neither loopback nor declared in `client-connection`'s `trustedHosts`, and the settings RPC the client now calls already answered any caller the deployment admitted: it is not gated on the page authority, and never was. What changes is which surface the client offers, not what the Host will do for a request that arrives.

<a id="composition"></a>
## Composition

This package is in no shipped bundle. A deployment inserts the row over any surface:

```yaml
- insert:
    - id: server-base
      name: '@deepseek-ai/dsh-experimental-server-base'
      config:
        ownsHost: true
```

Over a plain surface, `dsh --profile web --patch <path>` applies it. The customer console is different: it is the [`@deepseek-ai/dsh-experimental-console-profile`](../console-profile/README.md) bundle plus a deployment bundle of the deployment's own, and this row goes into that deployment bundle. A console assembled with `--patch` cannot save its sidebar menu, because the settings service writes the menu into the profile patch and config-editor refuses a row that a layer above that patch composes. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package. Set `ownsHost` only under the conditions [Claiming the Host](#claiming-the-host) states.

<a id="the-proxy-half"></a>
## The proxy half

`deploy/nginx.console.conf` is the matching reverse-proxy sample: `location /console/` and `proxy_pass http://127.0.0.1:3080/`, both with the trailing slash that performs the stripping, `Host` forwarded unchanged, the WebSocket upgrade headers for the two event sockets, and buffering off for streamed answers. It is written for an nginx built without `ngx_http_rewrite_module` but with `ngx_http_auth_request_module`, so it uses no `rewrite`, `return`, `if`, or `set`, and it publishes only the slash-terminated prefix: nothing available there can redirect `/console` to `/console/`, and a document served at the slashless address sits outside the `Path=/console/` a page writes its mirror cookie with, so the browser sends none back. Every link published outward carries the trailing slash.

dsh authenticates nobody, so that sample also carries the deployment's only authentication: an `auth_request` gate declared once on the `/console/` location and cancelled address by address beneath it. It is therefore deny-by-default — `/console/api` with both event sockets, every route a composed plugin registers, and the content app are all gated without being named, where a gate on an entry point alone would have left the RPC uplink open. What the sample does open is the bootstrap, and it has to: the credential a navigation can carry is the cookie auth-gate mirrors the token into, and the only thing that writes that cookie is the console's own page. A gate over the document as well would make itself and its own only credential each other's precondition, and a visitor with an empty cookie jar — a first visit, another browser, cleared site data, or the sign-out that clears this very cookie — would be refused at the one page that could have written it, with no path back. So the shell document, the files it references, the service worker script `/sw.js`, the client plugin bundles, the gate's own `/auth-gate/settings` document, and component-kit's `/component-kit/settings` document are served to anyone. What that publishes is build output plus three facts about the deployment — the composed plugin list and the stored theme preference the shell document carries, the three configured values in auth-gate's settings document, and the data page's request prefix in component-kit's, which its browser half reads once as the shell starts — and no conversation, session, or workspace content. The in-page gate, whose login page must itself stay reachable outside this one, decides on shape and expiry alone: a stored value that is not a JWT with an `exp` still ahead sends the visitor to the login page, and nothing else does. The check that proves this half, to re-run whenever that list changes: with an empty cookie jar, `GET /console/` answers 200 and the shell document while `GET /console/api/anything` answers 401 and the fixed page.

Neither nginx nor its verifier validates a token locally. nginx sends each gated request's credential, in an auth subrequest, to the verifier — `deploy/proxy.mjs` run in verify mode, described in [the deploy proxy and verifier](#deploy-proxy) — which asks the deployment's own authentication service and answers 200 to admit, 401 to refuse, or 503 when the service cannot answer, so expiry, rotation, and revocation stay with the service that issued the token. The credential is the `Authorization` header when a surrounding product's page sends one, and otherwise that mirror cookie — which is what covers every asset, each iframe, and the two WebSocket handshakes, none of which can carry a header. The sample's cookie name must be spelled the same as that auth-gate row's `cookieName`; any other spelling reads an empty cookie and closes the console to everyone. nginx caches no answer: the verifier remembers its decisions in memory for `AUTH_CACHE_SECONDS`, which is also the longest a revoked token keeps working, and signs each 200 afresh, so no member assertion is replayed and no token is written into a cache file. The `/console/` block forwards the `X-Dsh-Member` value the verifier returned and nothing else under that name; the exempt locations inherit that line with an empty value and so forward no such header. A refusal serves a fixed page the deployment supplies, not a redirect: nothing there can redirect, and an `/api` or WebSocket request needs a status rather than a login document. The hop from the verifier to the authentication service carries the deployment's only authentication decision, so an https `AUTH_ORIGIN` is certificate-checked against Node's CA list or the `AUTH_CA_FILE` trust store; an authentication service reached over plain http on a private network is the other supported form. The verifier's 503, like any answer that is neither 200 nor 401 nor 403 and a verifier that cannot be reached at all, becomes a 500, which a second fixed page answers: temporarily unavailable, rather than sign in again.

That sample is half the deployment. Forwarding `Host` unchanged is what the `/api` browser-trust fence and its Origin comparison read, and that fence refuses every Host that is neither loopback nor a declared authority — so the process must also carry the public name in `client-connection`'s `trustedHosts`, declared in the deployment's own overlay layer. Without it the **process** answers 403 to every `/api` request while the page itself loads, and nginx is not involved in the refusal.

A prefix that is not stripped completely does not fail as a clean 404 either: the un-stripped path leaves the static dist root, and the traversal check refuses it with 403 — a different refusal from the fence's, and equally not an authentication problem.

No `sub_filter` is needed. The served index carries `<base href="./">` from `dsh-host-frontend-static`, so the page resolves every URL it builds against the directory it was loaded from, and nothing names the prefix for nginx to rewrite; a byte filter could not reach the URLs that matter anyway, because runtime code assembles them from strings that never appear whole in a response.

<a id="deploy-proxy"></a>
## The deploy proxy and verifier

`deploy/proxy.mjs` is the login gate for a deployment whose front proxy cannot run `auth_request`, and the verifier that `deploy/nginx.console.conf` asks where it can. It has no dependencies, runs as `node proxy.mjs` on Node 22.19 or newer, and starts nothing when imported. `PROXY_MODE=proxy`, the default, is a same-origin reverse proxy: the dsh console's own paths go to the dsh process on `127.0.0.1` at `DSH_WEB_PORT`, and every other path goes to the remote application — the customer system the console embeds — at `REMOTE_HOST` and `REMOTE_PORT`; paths of the remote application are never gated, because it enforces its own login. `PROXY_MODE=verify` proxies nothing and answers each nginx auth subrequest with 200 to admit, 401 to refuse, and 503 when the authentication service cannot answer.

A login is live when the authentication service accepts the whole token and the token names a member. The credential is the mirror cookie in proxy mode and the `Authorization` header the template fills in verify mode. The gate decodes the token's payload without checking its signature — the customer system signs with a symmetric key the gate does not hold — and refuses, without asking the service, a token whose payload names no `login_uid` or fails a configured claims check. It then sends `GET` to `AUTH_ORIGIN` at `AUTH_CHECK_PATH` with the credential on both `Authorization` and `CertificationToken`. 401 and 403 refuse; any other status, a timeout, or a reply body over 64 KiB counts as unavailable. A 2xx admits, and with `AUTH_CHECK_REPLY=renewal` only when the reply's `token` field names the same `login_uid` and `jti` as the submitted token, because the renewal endpoint answers a live token with that same token. A 2xx means the customer system accepted the whole token, so the `login_uid` in its payload is the member. A numeric `login_uid` keeps its exact digits: the gate reads JSON numbers as their source text, which needs the `JSON.parse` source text access Node 21 and later provide, and it refuses to start on a runtime without it. Admissions are cached in memory with their member for `AUTH_CACHE_SECONDS` and refusals for 10 seconds, concurrent checks of one credential share one request, and past 64 checks in flight a new one answers unavailable rather than queuing.

Every request and WebSocket upgrade the proxy forwards loses any `x-dsh-member` header the client sent, in any casing and with underscores in place of hyphens, on dsh paths, exempt paths, and remote-application paths alike. With a signing key configured, each request the gate verified and forwards to dsh also carries a freshly signed member assertion, and the verifier returns one with each 200 in its `X-Dsh-Member` response header; exempt paths, remote-application paths, and a gate turned off carry none. The value is `v1.<payload>.<signature>`. `<payload>` is the base64url of the JSON `{"p": "<login_uid>", "aud": "<MEMBER_ASSERTION_DEPLOYMENT_ID>", "exp": <Unix seconds>}`, where `p` is always a string and `exp` is 120 seconds after signing, and `<signature>` is the base64url Ed25519 signature over the ASCII string `v1.<payload>`. A verifier accepts an assertion only when the signature checks against the deployment's public key, `aud` equals its own deployment id, and `exp` is still ahead. Without a signing key the gate only strips the header, which keeps a single-member deployment working unchanged. dsh itself ignores the header; telling members apart needs a host-side component that verifies it, which is not part of this repository yet. No log line carries the member id, the assertion, or the token: refusals log their reason category and the request path without its query.

The proxy frames every body it forwards itself, so a body reaches the upstream as the body of its one request and never as a request of its own, which would pass the gate unchecked with whatever `x-dsh-member` it named. The client's `Content-Length` is forwarded as sent, a chunked body is re-encoded as chunked, and a request with neither carries no body. A request carrying both `Content-Length` and `Transfer-Encoding`, or a `Transfer-Encoding` other than `chunked`, is answered 400 with the connection closed, before the login check and before anything upstream is contacted. In both modes a message Node's parser refuses is answered 400, a header section over Node's size limit 431, and a request that does not arrive within Node's headers or request timeout 408; a client that leaves before its request is complete is sent nothing and logged nothing. A request whose client disconnects during the login check is never sent upstream, nor is an upgrade whose client resets the connection then, and a client that disconnects before its body is complete has its upstream request dropped. A WebSocket handshake that declares a body is answered 400 the same way. The handshake is then sent upstream alone: only a 101 answer opens the client-to-upstream direction and passes on the bytes the client sent after the handshake, any other answer is relayed to the client with nothing more sent upstream, and an upstream that cannot be reached, or that closes or runs past 64 KiB before its response head is complete, is answered 502, as a request to an unreachable upstream is.

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_MODE` | `proxy` | `proxy` or `verify`. |
| `PROXY_HOST` | `127.0.0.1` | Listen address. |
| `PROXY_PORT` | `8082` | Listen port. |
| `DSH_WEB_PORT` | required in proxy mode | Port of the dsh process on `127.0.0.1`. |
| `REMOTE_HOST`, `REMOTE_PORT` | required in proxy mode | Address of the remote application; an IPv6 address is written without brackets. |
| `LOGIN_GATE` | `on` | `off` forwards every path without a login check. |
| `AUTH_ORIGIN` | `http://<REMOTE_HOST>:<REMOTE_PORT>`, an IPv6 `REMOTE_HOST` in brackets; required in verify mode | Origin of the authentication service, `http:` or `https:`, with no userinfo or path. |
| `AUTH_CA_FILE` | unset, which trusts Node's bundled CA list | PEM file of the CA the https hop's certificate must chain to. |
| `AUTH_CHECK_PATH` | `/nrms-auth/api/renewal` | Path each credential is checked at. |
| `AUTH_CHECK_REPLY` | `renewal` | `renewal` also matches the reply token's `login_uid` and `jti`; `status` reads the status alone, for a path that does not answer with the token. |
| `AUTH_COOKIE` | `accessToken` | Mirror cookie read in proxy mode, spelled as the auth-gate row's `cookieName`. |
| `AUTH_CACHE_SECONDS` | `30` | How long an admission is remembered, and so the longest a revoked token keeps working. |
| `EXPECTED_ISS` | unset | When set, the token's `iss` must equal it. |
| `ALLOWED_TENANTS` | unset | Comma-separated; when set, the token's `tenants`, an array or one comma-separated string, must list one of them. |
| `ALLOWED_APP_IDS` | unset | Comma-separated; when set, the token's `login_app_id` must be one of them. |
| `MEMBER_ASSERTION_KEY_FILE` | unset | Path of the Ed25519 private key in PEM; when set, the gate signs member assertions. |
| `MEMBER_ASSERTION_DEPLOYMENT_ID` | required with the key | The assertions' `aud`. |
| `DSH_LAUNCH_TOKEN_FILE` | unset | File holding dsh's launch token; when set in proxy mode, a visitor dsh refuses at `/` is sent through dsh's own token exchange. |

Startup exits 1 with a message naming the variable on any invalid value and on these combinations: a key without a deployment id, a deployment id without a key, a key with `LOGIN_GATE=off`, because only a verified login names a member, `PROXY_MODE=verify` with `LOGIN_GATE=off`, a key that is not Ed25519, `AUTH_CA_FILE` with an http origin, and an allow-list that lists nothing. A `REMOTE_HOST` that does not form an http origin is reported against `REMOTE_HOST`, also when `AUTH_ORIGIN` is derived from it. A listen that fails exits 1 too, naming `PROXY_PORT` for a port in use or not permitted and `PROXY_HOST` for an address that is not local or does not resolve.

The assertion is asymmetric so that the dsh host holds only the public key: code running as the host's OS user — an agent's file tools, or `/api/file`, which serves any path the host can read, `/proc/<pid>/environ` included — can read a public key and still forge nothing. That holds only while the private key file is unreadable by the dsh host's OS user, which means running this gate as a separate OS user or in a separate container; the environment carries the key's path, never the key. A deployment that runs this gate and dsh as the same OS user in one container, as the hosted console does today, does not meet that premise: whoever can run code on the host can read the key file and this process's environment. Until the two are separated, forgery protection there rests on the network alone: dsh listens only on `127.0.0.1` inside the container, so only processes in that container reach it, this gate replaces whatever header a client sends, and the console preset composes no shell tool.

Whether a deployment forwards a client's own header can be checked from outside with curl and a stand-in that reports only whether the header arrived, never its value. Stop dsh, run `node -e "require('http').createServer((q, s) => { const v = q.headers['x-dsh-member']; console.log(q.url, v === undefined ? 'absent' : v === 'forged' ? 'FORGED VALUE PASSED' : 'signed value'); s.end() }).listen(3080, '127.0.0.1')"` on the dsh port, and send `curl -s -o /dev/null -H 'X-Dsh-Member: forged' https://console.example.com/console/assets/probe`: an exempt location must print `absent`. The same request to a gated path with a live mirror cookie (`-b 'accessToken=<token>'`) prints `signed value` where the verifier signs and `absent` where it does not; `FORGED VALUE PASSED` on any path means the configuration forwards client headers. The same stand-in on `DSH_WEB_PORT` checks proxy mode.

## Model Experience

None, as this package registers no tool, prompt section, or result: it contributes one index-injection row to the HTML a browser is served, which is decided and rendered outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

- **Per-origin browser storage is shared between prefixes.** `localStorage` and `CacheStorage` are isolated by origin, never by path, so two deployments at `/a/` and `/b/` on one hostname share the shell's workspace view, conversation drafts, and any token a page mirrors, and overwrite each other's. Nothing in this package can separate them; a deployment that needs separation needs a hostname per deployment.
- **PWA is not supported under a prefix.** A service worker's scope is decided by its script URL, and a web-app manifest identity is resolved against the origin rather than the prefix. A server-line profile must compose no PWA layer; one composed under a prefix would install a worker claiming more of the origin than the deployment owns.
- **The prefix is browser-side only.** Nothing teaches the process its own prefix: routes stay root-absolute and the proxy must strip. A deployment that cannot strip — a proxy that must forward the prefix intact — needs the route table, the RPC endpoint parser, the api-proxy path matcher, and the privileged-method fence to learn the prefix together, which is a different change from this one.
- **The gate does not cover the shell itself.** The document, the files it references, the client plugin bundles, and `/auth-gate/settings` are served to anyone who asks: the in-page gate writes the only credential a navigation can carry, so gating them would leave a visitor with an empty cookie jar no way in. What that publishes is build output plus three configured values, and the console paints before the visitor is known — the window auth-gate's own Known Limitations record. A deployment that must not hand its shell to an anonymous request needs a gate that can issue the credential itself, which is a different sign-on from this one.
- **A refused token that has not expired strands the visitor.** The in-page gate decides on shape and expiry alone — a stored value that is not a JWT with an `exp` still ahead is what sends the visitor to the login page — so a token the authentication service refuses while it is still unexpired (revoked, signed with a rotated key, an account since disabled) is usable to it and a refusal to the site gate. That visitor is served the bootstrap, the console paints, and every gated request behind it fails: a navigation outside the open list lands on the fixed page, and the page's own calls keep failing until the token's own expiry or a press of sign out. Leaving for the login page on a 401 from the page's own calls is the missing half, recorded in [auth-gate](../auth-gate/README.md)'s Known Limitations.
- **Sign-out cannot always reach the process.** auth-gate's sequence posts `/auth-gate/logout` first, so the node half stops spending a credential the visitor no longer has, and that request carries the mirror cookie this gate validates rather than merely routes by. On the paths that surrender a token the gate refuses, nginx answers that post 401 and the process keeps the dead token until it ends or a newer one is posted. The visitor still leaves, because the steps after it run whatever the one before did.
- **The ownership claim admits no distinctions between visitors.** `ownsHost` is one fact about the deployment, so every visitor the gate admits reaches the same operator surface and writes the same Host settings document; nothing here can tell two of them apart, and a later write wins over an earlier one with no notice to either. A deployment that needs one settings document per person needs one process per person.
- **The member assertion is signed but not yet verified.** dsh ignores `X-Dsh-Member`, so every admitted visitor is still the same operator; separating them needs a host-side component that verifies the assertion. Where this gate and dsh share an OS user, as on the hosted console, the private key is readable from the host, and forgery protection rests on dsh listening only on loopback ([the deploy proxy and verifier](#deploy-proxy)).
- **A URL leaving the page is not covered.** The document base governs URLs the page resolves; anything handed to something else — a download the browser's download manager fetches, an address copied into another tab — must already be absolute. Those call sites build absolute URLs themselves and this package does not check them.
- **Not covered by an assembled snapshot** — the evidence is this package's real-composition suite against a served index; the snapshot lanes replay the shipped composition, which does not compose an experimental row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
