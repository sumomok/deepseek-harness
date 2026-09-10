# Agent Note: the deployment declares that its page owns the Host

Status: implemented

English | [中文](2026-09-10-server-base-owns-host.zh.md)

## Problem

The console is served at `https://lhr.ink/console/`, and that authority is not loopback. `packages/client/connection/src/client/index.ts` builds `ConnectionHandle.isLoopback` from three things: a page-global carrier's `ownsHost`, the absence of a `location` at all, and a loopback hostname. A public authority satisfies none of them, so the client reads the page as somebody else's Host and stands down the surface it keeps for an operator's own machine.

The visible half of that is settings. `packages/client/ui-settings/src/client/index.ts` picks `persistence = ctx.remote.$host.isLoopback ? 'host' : 'memory'`, and a memory mirror starts and stays `unavailable` (`settings-mirror.ts`), so every settings section — the MCP servers plugin among them — tells the visitor it cannot read settings. `ui-settings-general` builds no settings-document controller off loopback, and `ui-deliverables` does not offer to open a produced file's path on the Host.

Nothing served could say otherwise. The one page global that overrides the authority, `__DSH_TRANSPORT__.ownsHost`, was written by exactly one shell: `packages/experimental/webworker-runtime`, whose Host runs in a worker the page spawned. A page served over HTTP had no way to state the fact that its deployment already knew — that nobody reaches it but the Host's operator.

## Decision

**The declaration is a deployment fact, so it lives with the package that already carries this line's deployment facts.** `packages/experimental/server-base` gains a validated `ownsHost` boolean, `false` unless a deployment writes it. It sits beside `basePath`, which is the same kind of fact: something true of how this process is published that the served page cannot work out for itself.

**When it is set, the plugin contributes one more head row behind the prefix rows**, an inline script rendered verbatim as `<script>globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };</script>`. The carrier it installs is not a transport: `fetch` is `(input, init) => globalThis.fetch(input, init)`, which is exactly the caller `createWebConnectionRpc` uses when no carrier is present, and it declares no `openStream` and no `loadBundle`, so the RPC keeps its HTTP requests and its Gateway WebSocket and the client module system keeps loading bundles over HTTP. `ownsHost` is the one fact the row exists to carry. The assignment is `??=`, so a shell that assembled a real carrier for itself keeps it.

**Left unset, the served index is unchanged.** The row is absent, no global is defined, and the prefix rows render exactly as before.

### The contract on who may set it

`ownsHost` declares that whoever reaches the served page is this Host's operator. It is a claim about the gate in front of the page, never about the visitor: every visitor that gate admits then gets the operator surface, and they all share the one Host behind it. This deployment's gate is the dsh browser session cookie plus the proxy's `auth_request` login gate, both described in `packages/experimental/server-base/README.md`.

It moves no server-side check. The `/api` browser-trust fence (`packages/client/connection/src/api-request-trust.ts`) still refuses a Host that is neither loopback nor a declared `trustedHosts` authority, and that fence states its own scope: it is not an auth layer. The settings RPC the client now calls is not gated on the page authority either — `packages/api/settings-controller/src/index.ts` declares `update`, `replace`, and `mutate` as ordinary `@Remote` methods — so it answered any caller the deployment admitted before this row existed. What the row changes is which surface the client offers, not what the Host will do for a request that arrives.

## Alternatives considered

**Teaching `client/connection` to read a served page's own deployment as loopback** — for instance treating a declared `trustedHosts` authority, or the presence of the browser session cookie, as ownership. Rejected: that is an upstream core package, and this line does not change upstream core where a composition layer can carry the same fact. It would also make a browser-authority judgement for every deployment that composes the spine, including the ones where the authority is exactly the right answer.

**A new `client-connection` Config field** saying the same thing. Rejected for the same core-change reason, and because the page global it would feed already exists and already has this meaning.

**Assembling a full carrier** — `fetch`, `openStream`, and `loadBundle` — the way the worker preview does. Rejected: it would move the Gateway stream off the WebSocket and the plugin bundles off HTTP to arrive at behavior identical to the page's own defaults, for one boolean.

**Setting the global from the shell's own code in `apps/web`.** Rejected: the shell is built once and served by every deployment, while the fact varies per deployment; the index is where per-deployment facts are already injected.

**Authorizing the privileged surface per visitor on the Host instead.** Rejected as a different change, not a smaller one: dsh authenticates nobody, the settings RPC is ungated, and per-visitor authorization would need an identity the Host does not have. That work is recorded where the deployment's sign-on is, not here.

**Leaving settings unreadable and editing the settings file on the server host instead.** Rejected: the MCP servers a console operator mounts are configured from that surface, so the console would ship with its own plugin telling every visitor it cannot read settings.

## Consequences

**Bought.** A console behind a login gate offers the operator surface it was built with: the settings sections read and write the Host's settings document, the settings document actions appear, and a produced-file chip offers to open its path on the Host.

**Paid.** One boolean now decides whether an admitted visitor reaches that surface, and the deployment — not the process — is what makes the decision sound. The claim admits no distinctions: every admitted visitor writes the same settings document, and a later write wins over an earlier one with no notice to either. That limitation is recorded in the package README.

**Evidence.**

| Claim | Evidence |
|---|---|
| A deployment that claims nothing serves no carrier at all | `packages/experimental/server-base/tests/server-base.spec.ts`, over the index the real composition serves |
| A deployment that claims the Host serves the carrier verbatim, behind the `<base>` element and ahead of the shell's entry module | the same file, which pins the rendered markup |
| The claim defaults to unset, and a value that is not a boolean fails the row | the same file's `Config` cases |
| The prefix rows, their order, and the index of a composition without the row are unchanged | the same file's existing cases, which pass unmodified |

`pnpm exec vitest run packages/experimental/server-base`: 14 tests. `pnpm run typecheck`, `pnpm run lint`, `pnpm run test:docs`, `pnpm run verify-config-catalog`, and `pnpm run verify-export-jsdoc` green.
