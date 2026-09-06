# Agent Note: merging the server-console line forward onto the 0.1.2-rc.1 root

Status: implemented

English | [中文](2026-09-06-console-merge-forward.zh.md)

## Problem

Two long-lived lines had drifted onto different upstream roots. `product/server-console` carried the service-line shell — the sidebar replacement, the content column's `component` kind, the deployment path prefix, the data-backend reads — on a pre-rc.1 root. The eyes-and-hands line had already moved to `0.1.2-rc.1`, about 1800 upstream commits later, where whole packages the console line edited no longer exist (`packages/host/apiproxy`, `packages/client/runtime`, the `examples/` tree), where the browser half is gated by a launch token, and where the composer is a contenteditable surface rather than a form control.

A file-by-file merge cannot resolve that. A conflict in an upstream-root file is not two spellings of one decision: one side is the current root and the other is a change made against a root that is gone, so the resolution is to find where the changed code now lives and carry the decision there. Left as a textual merge, the result compiles and boots and then fails in the places nothing looks: a URL that addresses the origin root under a path prefix, a page that never renders because a disabled row is now a hard dependency, a seeded session the store refuses as corrupt.

## Decision

**Every conflict is resolved by class, and the class decides which side is the base.** Upstream-root files take the rc.1 side and the console change is carried onto it semantically. Generated documentation takes either side and is regenerated. `pnpm-lock.yaml` takes ours and is reinstalled. `packages/experimental/server-sidebar` takes the console structure and re-acquires this line's rc.1 adaptations. Every other experimental package and every `apps/web` test keeps both sides.

### The three ports onto packages that no longer exist

`packages/host/apiproxy` is gone. Its fetch client's deployment-base behaviour — a base with a trailing slash, and a private path join that strips the leading slash so the prefix extends rather than is replaced — now lives in two places. `packages/client/connection/src/client/rpc.ts:64` builds the uplink with `clientUrl(`${channel}/${endpoint}`)` and owns no `resolveBase()` of its own; `packages/api/gateway/src/client/stream-client.ts` carries the downlink, whose `remoteStreamUrl()` resolves `REMOTE_STREAM_MUX_PATH` through `clientUrl` and then swaps the scheme to `ws:`/`wss:`. The Gateway therefore declares `@deepseek-ai/dsh-client-connection/client` as a `dsh.client.external`, which it may because it is not a `packages/client/` row.

`packages/client/runtime` is gone; `ClientContext` is `Context` from `@deepseek-ai/cordis`, `SlotRegistry` comes from `@deepseek-ai/dsh-client-ui-renderer/client`, and `SessionId` from `@deepseek-ai/dsh-session/types`.

The `examples/` tree is gone: runnable configurations live under `apps/cli/config/examples/` and the snapshot lanes under `snapshots/`. `examples/content-console/` is kept where it is, with the five workspace dependencies the console line had added to the deleted root manifest moved into its own `examples/content-console/package.json`. It is dormant on this root — no workspace member, absent from `vitest.snapshot.config.ts`, and it names `@deepseek-ai/dsh-acp-demo`, which no longer exists — and re-homing it under `snapshots/` is not part of this merge.

### What the deployment prefix costs on the rc.1 root

`packages/client/modules/src/index.ts` mints the combo route root-absolute and projects it into a page-relative URL at the one point the page reads it: `pageUrl()` strips the leading slash for the graph row and the batch descriptor, while the served response map stays keyed by the root-absolute route. The stamped `sourceMappingURL` keeps the route spelling, which is why `packages/client/modules/tests/node-half.client.spec.ts` compares the two through `routeOf()`.

`packages/host/frontend-static/src/index.ts` injects `<base href="/">` into every index it renders, ahead of the rows `webserver/index-inject` contributes. One document carries one base and the parser honors the first, so that default would silently replace the prefix `dsh-experimental-server-base` injects. The dist server now injects its default only into a document that carries no base of its own, which is the whole of the coupling between the two packages.

`packages/client/hmr` needs no deployment-base helper at all. rc.1 refuses a `packages/client/` package a runtime external onto another client row, and an `EventSource` opened with the route relative is resolved by the browser against the document base — the same resolution `clientUrl` performs, done by the page.

### The four packages the console line adds

`biz-backend`, `component-kit`, `component-surface`, and `server-base` are carried onto the rc.1 client API (`session.snapshotEvents()`, `ToolCallId`, `CommandRowProps` from `@deepseek-ai/dsh-client-ui-chat/client`, the `contentSurface` fold) and onto its package rules: the root version, and `./invariant` published only for a companion that checks an owned relation. Three published one whose install function was empty, which rc.1 rejects, so the companion and its wiring are gone and each README states in one line why the package publishes none. `component-kit`'s vendored `element-ui.css` is exempted by name from the `client/ui-theme` stylesheet contracts, which range over this product's own drawing rules.

### What the browser lane had to learn

The `apps/web` scenarios the console line brought were written against a root with no launch-token gate, a `<textarea>` composer, and a different route table. Each is adapted rather than weakened: a scenario establishes its session through `scaffold.authenticatedUrl` (and `base-path.e2e.ts` through the proxy, so the cookie is minted for the authority the tab uses); the composer is `[data-composer-input]` driven through `writeComposerDraft`; the RPC probe asks for `/api/session/list`; the one WebSocket downlink is `/api/remote.mux`; the export controller fetches rather than probes; the application batch is a preload link, not a second parser-blocking script; a seeded `tool/result` carries an identified message, without which the store refuses the session as corrupt; and a folded turn process is opened before a context row inside it is read.

Four compositions no longer disable `@deepseek-ai/dsh-client-ui-workspace`: the shipped `packages/experimental/server-sidebar/overlay/customer.patch.yml` and the three test overlays `apps/web/tests/server-sidebar.overlay.yml`, `server-sidebar-homepage.overlay.yml`, and `server-sidebar-views.overlay.yml`. On rc.1 `dsh-client-ui-conversation` names `uiWorkspace` in its `inject` list and reads the service in its `apply()`, so disabling that row leaves the entire conversation column pending and the page renders nothing.

That changes what a customer deployment loads, not only what a test composes. The hero-phase workspace chip and its picker went from never-loaded to loaded, mounted, and hidden in CSS: `ui-workspace`'s `conversation.hero.workspace` registration now lands, the chip carries a real Workspace title, and its picker menu is live behind a `display: none`. The only barrier is `terminology-guard.ts`'s `heroWorkspaceRow` rule — which is why that rule is asserted by presence-plus-invisibility rather than by invisibility alone, and why the shipped overlay carries the reason in a comment where the disable row used to be.

## Alternatives considered

**Rebase the console line onto rc.1 instead of merging.** Rejected: the console line is a long-lived branch that never merges into `develop`, and its history is the record of the product decisions the deployment runs on. A rebase would have rewritten every one of them against a root they were not written for, one commit at a time, with no point at which the tree was testable.

**Keep `packages/host/apiproxy`'s carrier alive as a compatibility shim.** Rejected: it was deleted upstream because the Gateway stream client replaced it. Reviving it would have kept a second RPC carrier in the tree whose only consumer is a port that already has a home, and the pre-release stance is to fix the reference rather than to keep the referent.

**Give `client/hmr` the deployment-base helper by seeding `client-connection` into the platform module table.** Rejected: the seeded table is the shell's shared platform (React, Cordis, the store, the slot registry), and the dev channel's one URL does not justify moving a feature package into it. Relative resolution is what the base element is for.

**Leave `ui-workspace` disabled and provide a stand-in `uiWorkspace`.** Rejected: a stand-in would have to satisfy a service the conversation column actually calls, so it is a second implementation of a shipped package maintained against upstream's, to avoid two CSS-hidden surfaces the guard already hides.

**Regenerate the Chinese sides of the generated catalogs from the English by machine translation.** Rejected: those files are reviewed counterparts maintained by pairing, and their own headers state the procedure — regenerate the English, then bring the Chinese side along. The rows this merge adds are mirrored by hand and the pairing records re-recorded.

## Consequences

The console line's browser scenarios now run against the rc.1 shell, which is the only way its deployment decisions stay checkable: the prefix scenario proves that nothing addresses the origin root, and the sidebar and component scenarios prove the console composition still boots and draws. What that cost is that four of those scenarios now depend on rc.1 shell details — the composer's attribute, the turn-process folding, the launch-token exchange — which a later upstream change can move again.

The `examples/content-console` tree is dormant: it is carried, it is not run, and nothing gates it. It stays a decision to make rather than a silent deletion.

Two failure modes are now covered that were not before. A dist server injecting its own `<base>` ahead of a deployment's is a blank page under a prefix, and `packages/experimental/server-base/tests/server-base.spec.ts` asserts the served document carries exactly one base. A composition that disables a row another row injects renders nothing with no error anywhere, and the views scenario is what would catch it again.

## Testing

`pnpm run test` leaves five files failing, all environment-dependent and untouched by this merge (`git diff 467f171a9b..HEAD` is empty for all of them): the Python code runtime needs CPython ≥ 3.10 and this host has 3.9.6, `spill-local`'s boundary case turns on filesystem mtime granularity, and two `scripts/` specs read a pid and a terminal-colour warning. `pnpm run duplication` reports six clones, four of them present on the eyes parent and two on the console parent — the merge introduces none and removes one.
