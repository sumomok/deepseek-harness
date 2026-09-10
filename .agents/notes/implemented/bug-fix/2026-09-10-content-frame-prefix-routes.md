# Agent Note: the read channel addresses the deployment prefix

Status: implemented

English | [中文](2026-09-10-content-frame-prefix-routes.zh.md)

## Problem

On the deployment that publishes the customer console under `/console/`, every `content_read` ended the same way:

```
No console tab is showing this session's content column (waited 3s).
```

with the console open in front of the user and the page it was asked about on display. The five other page tools ended the same way, and the session log showed the host side behaving correctly throughout: the call was folded into `contentAccess`, published to every connected browser, and left pending for the whole claim window.

The browser side never arrived. `packages/experimental/content-frame/src/client/access/executor.ts` posted the three read routes as the node half spells them (line numbers as the defect stood):

- `post(CONTENT_CLAIM_ROUTE, …)` at `:344`
- `reportRead(CONTENT_REPORT_ROUTE | CONTENT_IMAGE_ROUTE, …)` at `:912`, `:918`, `:921`

each reaching one `fetch(route, …)` at `:277`. A root-absolute path resolves against the origin, not against the page's base, so under the prefix the seat asked `https://host/content-frame/claim` — an address the deployment's nginx routes nowhere near this process. The post ended `undelivered`, the bidding loop re-sent it into the same nothing until the call left the pending list, and the host's `claimTimeoutMs` composed the refusal above. The seat was working correctly; it was talking to the wrong host.

The settings route in the same package was already correct (`src/client/index.ts:130`), which is why the column itself rendered and only reading failed.

### Why the prefix work did not catch it

[The base-path decision](../architecture/2026-09-04-base-path-for-the-server-console.md) enumerated what the page builds at run time — three copies of `resolveBase()`, the two WebSocket downlinks, the HMR `EventSource`, "the settings routes four of this repository's own plugins fetch" — and [the merge-forward note](../process/2026-09-06-console-merge-forward.md) audited the merged tree again and named the two root-absolute addresses it was leaving in place (the combo source map's `sources[]`, and the PWA manifest).

Both audits looked for a route constant standing at a request site: a `*_ROUTE` next to a `fetch(`, a `new WebSocket(`, a `new EventSource(`. In this file the constant and the request are seventy lines apart with a local `post()` helper between them — `post()` takes `route` as an opaque string parameter, so the `fetch(` call site names no route at all and the three call sites name no `fetch`. Neither audit's search shape had a hit here, and each concluded the package was covered because its one visible route fetch, the settings one, was.

## Decision

**`post()` resolves the address; the route constants do not carry it.** The one `fetch` in the read channel is now `fetch(clientUrl(route), …)`, so all four call sites are covered by the helper they already funnel through, and `packages/experimental/content-frame/src/access/wire.ts` keeps `CONTENT_CLAIM_ROUTE`, `CONTENT_REPORT_ROUTE`, and `CONTENT_IMAGE_ROUTE` root-absolute — they are also the paths the node half registers, after the proxy has stripped the prefix. The JSDoc on `post()` states that the two halves need different addresses from the one value, which is why the resolution happens at the request rather than in the constant.

The package already declared `@deepseek-ai/dsh-client-connection/client` as a `dsh.client.external` for the settings fetch, so this added no dependency.

One browser address in this package is still not resolved this way, and stays that way: a page's configured `url`, which the frame requests as it stands. A prefixed deployment writes the prefix into that value itself, because it is deployment data rather than a route this process registers — `src/types.ts:229` owns that contract and the README's [Pages the agent may show](../../../../packages/experimental/content-frame/README.md#pages-the-agent-may-show) section states it.

## The sweep

Every browser half under `packages/experimental/` was inventoried for the same class of defect — `fetch`, `EventSource`, `WebSocket`, `XMLHttpRequest`, `sendBeacon`, `axios`, dynamic `import()`, and every `*_ROUTE`/`*_PATH` constant reachable from a `src/client` tree. Thirteen packages ship a browser half. This was the only defect.

- **Already resolved through `clientUrl`:** `auth-gate` (settings, token, logout), `server-sidebar` (identity, nav catalog, workflow menu, the gate's settings and logout), `vue2-echarts-tool-poc` (settings, report), and `content-frame`'s own settings route.
- **Deliberately not resolved, and correct:** `auth-gate`'s `browser.ts:203` renewal probe resolves against `location.href` on purpose, so a credential goes to this origin whatever `<base>` the document carries, and its path is the deployment's own upstream endpoint rather than a Host route. `content-frame`'s iframe `src` is the configured page `url` above. `inspector`'s bridge WebSocket takes a fully-qualified endpoint from its bootstrap; `webworker-runtime` resolves against `document.baseURI` already and otherwise fetches through the worker tunnel.
- **No browser-side network address at all:** `component-surface`, `content-column`, `server-layout`, `component-kit`, `client-ui-agent-team`, `vue-ui-poc`, `vue2-echarts-poc`. `component-surface`'s `/component-surface/views` route is registered and served node-side; its only browser reader is server-sidebar's nav catalog, which resolves it.
- **No browser half:** `content-surface`, `biz-backend`, `library-skills`. `biz-backend`'s `fetch` is node-side against an absolute configured backend URL.

## Alternatives considered

**Resolve at each of the three call sites instead of in `post()`.** Rejected. The call sites choose a route; the request site chooses an address, and there is exactly one of those. Spreading it would leave a fourth call site added later to remember a rule nothing enforces — which is the shape of this defect.

**Mint the route constants with the prefix in them.** Rejected. `wire.ts` is shared by both halves, and the node half registers those same values as paths on a process the proxy has already stripped the prefix from. One value cannot be both addresses; the browser is the half that has to add it.

**Spell the constants relative and let `<base href>` resolve them.** Rejected for the same reason, plus a worse one: a relative path resolves against the document's base, which the server-base row and the dist server both write, so the read channel's address would depend on a value neither half of this package sets. `clientUrl` reads the same base but takes only its path and always puts it on the page origin, which is what keeps a `<base>` naming another origin from redirecting a claim.

**Let the process learn its prefix and register the routes under it.** Rejected repo-wide already; [the base-path decision](../architecture/2026-09-04-base-path-for-the-server-console.md) owns why (four independent path matchers, and a partial change produces 404s whose symptom points at routing).

## Consequences

- The read channel works under a path prefix, and a site-root deployment is unchanged: with nothing declaring a prefix, `clientUrl` resolves to the origin root, which is the address the seat posted before.
- The four jsdom benches that stub `fetch` for this seat now stand where the browser stands — they resolve whatever the seat handed `fetch` the way a document would, and route by path suffix rather than by constant identity. That is what makes the address assertable at all; it also means a future prefix regression fails on the address rather than on a missing document.
- **The browser lane does not cover a read under the prefix, and composing this package into the scenario that looks closest would not have covered it either.** `apps/web/tests/base-path.e2e.ts` boots the shipped shell plus `server-base` and `auth-gate` behind the stripping proxy, and its off-prefix assertion tests `ROOT_ROUTES = /^\/(api|plugins|auth-gate)(\/|$)/` (`:61`, filtered at `:257`). That is an allowlist of the three URL-building paths the scenario is about — the carrier, the module loader, and the gate — and `/content-frame/claim` matches none of them, so that scenario stays green with the read channel dead. Composing the four column rows into it would also replace `ui-layout` with `server-layout`, which is the shell its existing assertions are written against. The cheaper regression path is a sibling of `apps/web/tests/content-read-hidden.e2e.ts`, which already owns the overlay, the spliced `content/shown` plus open call, and the `ctx.tools.execute` drive under the same call id with zero model calls, plus `startPrefixProxy` from `apps/web/tests/prefix-proxy.ts` in front of it; what it asserts is the value the tool settled as, under the prefix. Roughly 200 to 260 lines, and a follow-up rather than part of this change.

## Testing

Two cases in `packages/experimental/content-frame/tests/content-read-executor.client.spec.tsx`, under `the addresses the seat posts to`. Both drive one text read and one picture read through the real seat and read back the addresses `fetch` was actually asked for: with `__DSH_BASE__` set to `/console/`, the claim, report, and picture routes must be `/console/content-frame/{claim,report,image}` on the page origin; with nothing declaring a prefix, the same three at the site root.

The prefixed case fails on the code before this change, with the production address in the diff:

```
- "http://localhost:3000/console/content-frame/claim"
+ "http://localhost:3000/content-frame/claim"
```

and the unprefixed case passes on both, which is what makes the first one about the prefix rather than about the bench. The package's other 849 cases are unchanged; the only edits to them are the four `fetch` stubs, which had to learn that the seat now hands `fetch` a resolved URL.
