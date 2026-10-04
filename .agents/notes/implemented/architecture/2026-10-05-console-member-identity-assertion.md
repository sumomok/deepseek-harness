# Agent Note: The console's login gate tells dsh which member sent a request with a signed assertion

Status: implemented

English | [中文](2026-10-05-console-member-identity-assertion.zh.md)

## Problem

One console process is to serve several customer accounts at once, and every per-member decision — whose sessions a request may touch, whose customer token a data read spends, whose browser an approval goes to — starts from knowing which member sent the request. The dsh Host cannot work that out by itself. The customer token is an HS512 JWT signed with a key only the customer system holds, so a claim the Host reads from it is unverified. The dsh browser cookie is an HMAC over a fixed payload (`packages/client/connection/src/browser-auth.ts`) and names no one, and the hosted console's proxy hands every visitor the same launch-token exchange, so every visitor holds a valid cookie. The party that does verify a login is the gate in front of dsh — `packages/experimental/server-base/deploy/proxy.mjs` on the hosted console, an nginx `auth_request` elsewhere — and it verifies by asking the customer system, not by holding a key. The [browser single sign-on Note](2026-08-28-browser-single-sign-on-and-mcp-token-injection.md) assumed one dsh process per signed-in person, with the person's id used inside the proxy to pick that process and never sent to dsh. One process for several members removes the routing that rule served.

## Decision

**The login gate is the only source of a member identity, and it sends one as a signed assertion.** After the customer system answers 2xx for a token, the gate takes the `login_uid` in that token's payload as the member. Under the renewal check it also requires the reply's `token` to name the same `login_uid` and `jti` as the submitted one, and a payload with no `login_uid` is refused. Each request the gate verified and forwards to dsh, and each such WebSocket upgrade, carries a freshly signed `x-dsh-member: v1.<payload>.<signature>`: the payload is the base64url of `{"p": <login_uid as a string>, "aud": <deployment id>, "exp": <issue time + 120 s>}`, and the signature is Ed25519 over `v1.<payload>`. The format lives in the server-base README, which a host-side verifier implements against.

**Every path removes the client's header.** The proxy's `forwardHeaders` drops `x-dsh-member` on HTTP requests and upgrades, on dsh, exempt, and remote-application paths alike, and sets it only from a fresh signature. In the nginx template the `/console/` block sets the header from the verifier's response, which keeps nginx from forwarding the client's value, and the exempt locations inherit an empty value and forward none. nginx does not cache the auth subrequest, so a 200 and its assertion are never replayed.

**One file serves both deployments, and signing is optional.** `proxy.mjs` runs as the same-origin proxy or, with `PROXY_MODE=verify`, as the verifier nginx asks. Without `MEMBER_ASSERTION_KEY_FILE` it only strips the header, which keeps a single-member deployment unchanged. A key without `MEMBER_ASSERTION_DEPLOYMENT_ID`, a deployment id without a key, and a key with the login gate off all stop the process at start.

**The private key is kept where the dsh Host cannot read it.** The environment carries the key file's path, never the key, and the file must be unreadable by the dsh Host's OS user: the gate runs as a separate OS user or in a separate container. The hosted console runs the gate and dsh as the same user in one container today; until the two are separated, forgery protection there rests on dsh listening only on `127.0.0.1` inside the container.

**Nothing in the Host reads the header yet.** dsh ignores `x-dsh-member`; a host-side component that verifies the assertion with the deployment's public key and admits the member it names is what makes it count.

### Numeric claims keep their digits

`login_uid` is a 19-digit number, past the range a JavaScript number holds exactly, so two members could collapse into one id if the claim is a JSON number. The gate's JSON reviver keeps every number as its source text, `p` is always that text, and the gate refuses to start on a runtime whose `JSON.parse` gives revivers no source text.

### The renewal reply is checked against the submitted token

The renewal endpoint answers a live token with that same token, so a 2xx whose `token` names another `login_uid` or `jti` is not an answer about the submitted token and is refused. `AUTH_CHECK_REPLY=status` reads the status alone, for a check path that does not answer with the token.

## Alternatives considered

**A plain member id header.** Any process that reaches dsh's port could name any member, so the header would prove nothing beyond the network position of its sender. A signed assertion also binds the member to one deployment through `aud` and expires two minutes after it is issued.

**A shared-secret HMAC instead of Ed25519.** The Host would hold the secret to verify it, and code running as the Host's user — an agent's file tools, `/api/file`, which serves `/proc/<pid>/environ` among any path the Host can read — could read the secret and sign for any member. With Ed25519 the Host holds only the public key.

**Verifying the customer JWT inside the Host.** HS512 needs the customer system's signing secret, and the Host holding it would let anything that reads the Host's files mint customer tokens; the gate asks the customer system for the same reason.

**The dsh browser cookie as the identity.** It identifies a browser session the gate admitted, signed over a fixed payload, and the hosted gate hands every visitor the same exchange, so it names no member.

**Keeping nginx's cache on the auth subrequest.** It would replay one signed assertion for up to its 30-second window and write the token into a cache file's key; the verifier's in-memory cache and request coalescing replace it.

**Keeping the two proxy copies outside the repository.** The acceptance-station copy had already diverged from the hosted one: no login gate, no path normalization before classification, and no guards against an async handler's rejection. Identity injection depends on this file, so it lives in the repository with tests, and each difference is an environment variable or, for the two route tables, the union of both lists.

## Consequences

Each verified request now names its member in a form the Host can check without being able to forge, once the key is isolated and a host-side verifier exists, and a captured header stops working two minutes after it was issued. The nginx template writes no token to disk.

Compared with the hosted copy it replaces, the gate refuses a token with no `login_uid` and a renewal reply whose token differs from the submitted one, both of which that copy admitted on any 2xx, and it reads up to 64 KiB of the reply body. `REMOTE_HOST` and `REMOTE_PORT` have no defaults, so each deployment names its remote application. Until the host-side verifier exists and the key file is unreadable by the dsh Host's OS user, the header separates no members. How the Host holds each member's customer token is a separate decision this Note does not cover.

## Testing

`packages/experimental/server-base/tests/deploy-proxy.spec.ts` runs both modes between a stand-in dsh and a stand-in customer system. It covers a forged `x-dsh-member` removed on HTTP, upgrade, exempt, and remote-application paths; no assertion on exempt or remote paths; a fresh assertion on a verified upgrade; refusal when the renewal reply carries another `login_uid` or `jti`; the claims checks; the start-time refusals; and log lines that carry neither member id, token, nor assertion. A verifier written in the test from the documented format accepts a fresh assertion and refuses an expired, altered, re-addressed, or foreign-key one.
