# Agent Note: the console reloads an open page on a new build instead of replacing client plugins live

Status: implemented

English | [中文](2026-10-02-console-reloads-on-a-new-build.zh.md)

## Problem

After a console server is upgraded and restarted, a page that was already open does not reload, and it cannot keep working on the client it loaded.

**Live plugin replacement breaks the page.** `dsh-web-app` composes `dsh-client-hmr`, which loads the host's changed plugin bundles into an open page. On 2026-10-02, on an isolated station, a page loaded from the console build that preceded the 0.2.0-rc.2 merge stayed open while the station restarted onto the 0.2.0-rc.2 build. The page did not navigate. After it reconnected, `client-hmr` fetched the changed plugin bundles by their new revisions and replaced them inside the shell the page had loaded, and the page then failed with `SlotAssemblyError: scope 'session-maybe' rendered without an installed adapter`, `conversation.input: sessions service unavailable`, an unknown-session binding error, and `ctx.remote.dynamicCordisRunner.syncInspectManifest is not a function`. The React root crashed and the page was white. A full reload, which loads the new shell, recovered it.

**The previous client does not work against the new server either.** The same upgrade with `client-hmr` disabled in the station's composition left the page drawn and its sidebar working, but once the page reconnected the conversation column crashed: `TypeError: Cannot read properties of undefined (reading 'foldCompletedTurns')` in `conversation.view`. 0.2.0-rc.2 moved the default of `ui-chat`'s `transcriptView` setting from the server to the client, so the previous client read `undefined` from the new server and found no policy for it. Turning live replacement off is therefore not enough: after an upgrade the page has to load again.

**A restart onto the same build must not reload.** Restarting the station onto the build the page already ran left the page in place: the connection retried, reconnected, and the page kept working. A reload there costs the visitor the page's state for nothing.

**Upstream never reloads a page.** Keeping a page live across reconnects and plugin changes is upstream's design, pinned by its own tests: `packages/client/modules/tests/entries.client.spec.ts` reports a bootstrap module that needs new code as a failure that requires a page reload and keeps every fiber, and `apps/web/tests/client-plugin-live.e2e.ts` asserts zero navigations.

## Decision

The console composition turns live plugin replacement off and reloads an open page once when the server it was served from comes back with a different build.

**`client-hmr` is disabled in `dsh-experimental-console-profile`.** The bundle layer carries `- id: client-hmr` with `disabled: true`, so an open console page never takes new plugin bundles into a running shell.

**`dsh-experimental-page-refresh` checks the build and reloads.** The console bundle layer inserts it. A build is the boot graph the served index assigns to `__DSH_BOOT__` — plugin ids with their revisions, compared as a set — plus the URLs of the index's module scripts under its base directory, which carry the web shell's build hash; a module script from elsewhere, such as one a browser extension adds, is part of no build. The page captures its own build once at plugin start. On every established connection (`connection/reset`, emitted by the API gateway's client on each connect) and on every return to the foreground while the page is connected, it requests the address it was served from, with no cache and no redirect following, and reads the build that index carries. Only a `200` HTML answer carrying the exact boot graph markup, with a graph that lists this plugin, is evidence; any other answer changes nothing. A graph without the plugin is what a host still composing its plugins serves, and a reload onto it would leave a page that never checks again. A different build is recorded in the tab's session storage and the page reloads at once by default; a later check that finds the recorded build again, or a tab without usable session storage, offers the reload in a banner instead. The same build clears the record. A host serves its index before it has composed its plugins, but the API gateway accepts a connection only once the launcher reports the application ready, after every plugin is composed; the check therefore reads the index only from a composed host. Plugin revisions derive from bundle file stats, so a composed host that serves the same files serves the same build and nothing reloads. The [package README](../../../../packages/experimental/page-refresh/README.md) owns the full behavior and configuration.

**One banner carries the page's notices.** The same package draws the reload offer and the connection notices — lost, reconnected, and unreachable with a reload button — as one `shell.overlay` entry, which `dsh-experimental-server-layout` renders in its frame-wide overlay layer. The console had no connection notice before: the settings panel's indicator draws only in the wide layout, and the console sidebar is not wide.

## Why fork code and not a core patch

The behavior inverts an upstream design choice that upstream's own tests pin. A change to `dsh-client-hmr` or the gateway would be a core patch re-applied on every sync, and it would change the shipped Web and Desktop products for every composition, not only the console. Reloading on a new build is a decision about one composition, so it lives in that composition: a fork-owned plugin and one disable row, both retired by deleting their rows.

## Why the index and not a route

A console deployment's reverse proxy forwards only the shell's own exact paths — `/`, `/index.html`, and the other files the shell serves — to the dsh process, and everything else to the customer's own backend. A new route such as a build-version endpoint would need that proxy changed on every deployment. The index the document was served from is already forwarded, and the host already renders the boot graph into it, so the check reads it and the node half publishes only its settings, as an index global. Requesting the document URL itself — the navigation entry's — keeps the request on the path the proxy forwards, under whatever prefix the page was loaded from.

## Testing

The package's suites pin the comparison, the reload guard, the superseding of an open check, the foreground check waiting for a connection, disposal before an answer, the connection notices, and the banner, and a real Loader composition pins the settings global the web server renders. `apps/web/tests/page-refresh.e2e.ts` holds a real page while the boot graph changes under it: a reconnect onto the same build changes nothing, the reconnect after one more client plugin is composed live reloads the page exactly once, and the reloaded page does not navigate again on the next reconnect; a module script a browser extension would add reloads nothing. `apps/web/tests/server-sidebar.e2e.ts` checks that the console composition serves the plugin without `client-hmr`, and that a page whose connection is refused draws the connection-loss notice in `server-layout`'s overlay layer, clear of the composer. `packages/experimental/console-profile/tests/profile.spec.ts` pins both rows in the bundle layer. The upgrade between two real builds is not reproduced in the repository; it is accepted manually on an isolated station.

## Alternatives considered

**Keep `client-hmr` and make it reload when the shell changes.** Rejected: it is a core patch against an upstream package whose design is never to navigate, and the evidence above shows that even with no live replacement the previous client fails against the new server, so the reload has to happen on every new build, not only on a shell change.

**Disable `client-hmr` alone.** Rejected by the station run above: the page no longer goes white, but the conversation column crashes against the new server's settings.

**Reload on every reconnect.** Rejected: a restart onto the same build recovers by reconnecting, and a reload there throws away the page's state; on a connection that keeps dropping it would reload repeatedly.

**Compare the boot graph's own `rev`.** Rejected: it hashes the entries and batches in the order the host lists them, and nothing establishes that order across two starts of the same build, so a same-build restart could read as a new build. Plugin ids and revisions compared as a set are stable by construction.

**Serve a build identity from a dedicated route.** Rejected for the proxy reason above; it would also be a second statement of what the index already states.

**Have the server tell open pages to reload.** Rejected: during the restart the pages are disconnected, and the new server does not know which build each page is running. The page knows, so the page checks on reconnecting.

**Only offer the reload, never perform it.** Rejected: the page that has found a new build may already be failing to draw, and the visitor would have to find a button on a broken page. The offer is the fallback when the reload guard or session storage rules the automatic reload out.

**Defer the reload while the composer holds an unsent draft.** Not taken: the composer writes its text draft to local storage on each edit and the reloaded page restores it with the selected conversation, so the text survives. Unsent image and file attachments are browser objects and are lost; deferring for them would keep the visitor on a client that does not work against the new server.

**Publish a flag that the host has composed its plugins, or request the index again after an answer that is no evidence.** Not taken: the API gateway registers its WebSocket upgrade only once the launcher reports the application ready, after every plugin is composed, so a check started by a connection never reads a host that is still composing, and the foreground check waits for a connection. A flag would restate that ordering in the index, and a repeated request would turn an answer that is no evidence into a reason to ask again.

## Consequences

**Bought.** An upgrade no longer leaves an open console page white or half-working: the first reconnect onto the new build reloads it. A restart onto the same build behaves as before. No deployment's reverse proxy needs a change. The console gains a connection notice it did not have, including an unreachable state with a reload button.

**Paid.** A plugin bundle rebuilt by `pnpm run dev:web` reaches no console page, open or newly loaded, until the host restarts, because `client-hmr` is what reports a rebuilt bundle to the host. Every connection and every return to the foreground while connected costs one request for the index. Unsent attachments are lost on the automatic reload. A page whose index request is refused — an expired browser session answers `401` — or redirected stays on its client until the visitor reloads. A rebuild with unchanged content still counts as a new build, because revisions come from file stats. Pages opened before this composition shipped do not carry the check and need one reload by hand, and so do open pages when a deployment removes the row or a build renames the package, because the check looks for the package name the page's client was built with. A build in the tree a running host serves before its restart, such as a `pnpm run dev:web` rebuild, makes the next check reload a page onto the new shell with the plugin bundles the running host loaded at start, and the restart then reloads it a second time; building into a separate tree and switching at the restart avoids the mixed page.
