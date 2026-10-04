---
description: "Reloads an open browser page once when the server it was served from comes back with a different build — compared through the served index's boot graph and shell scripts — and shows the page's connection state in one banner with a reload button; configures when the build is checked, the reload delay, and the connection notices."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-page-refresh

English | [中文](README.zh.md)

## Summary

Keeps an open console page on the build its server is running. After the server is upgraded and restarted, an open page reloads itself once when it reconnects, instead of running its previous client against the new server; a restart onto the same build changes nothing. One banner tells the visitor when the connection is lost, when it is back, and when the service stays unreachable, with a reload button. A tab reloads at most once per build; when that reload does not bring it onto the served build, the banner offers the reload instead.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The customer console composes it through [`dsh-experimental-console-profile`](../console-profile/README.md), together with a row that turns `client-hmr` off.

### When to choose it

Choose it for a deployment whose open pages must survive a server upgrade without the visitor reloading by hand. Compose it with the `client-hmr` row disabled, as the console does: with that row enabled, an open page also receives the new plugin bundles into the shell it already runs, and can fail to draw before the build check reloads it. A composition that wants live plugin replacement during development keeps `client-hmr` and leaves this package out. The decision and its evidence are in the [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-02-console-reloads-on-a-new-build.md).

### Minimal configuration

```yaml
- insert:
    - id: page-refresh
      name: '@deepseek-ai/dsh-experimental-page-refresh'
```

| Field | Default | Meaning |
|---|---|---|
| `checkOnVisible` | `true` | Also check the build each time the page returns to the foreground while it is connected |
| `reloadDelayMs` | `0` | Milliseconds between deciding to reload and reloading; a positive delay shows the reloading notice first |
| `disconnectNotice` | `true` | Show the lost, reconnected, and unreachable notices |
| `stuckAfterSeconds` | `60` | Seconds a loss lasts, with the browser online, before the unreachable notice and its reload button |

There is no switch for the whole plugin; a deployment that does not want it disables the row. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-experimental-page-refresh) is the exhaustive source for every accepted field.

### When the build is checked

Each time the page's connection to the server is established — the `connection/reset` event, the first connection included — and, with `checkOnVisible`, each time the page becomes visible again while it is connected. A page that is not connected leaves the check to its next connection: a host serves its index while it is still composing its plugins, with a boot graph that lists only some of them, and accepts a connection only once it has composed them all. At most one check is open at a time: a trigger that arrives while one is open aborts its request and starts a fresh check, so the verdict reflects the server as of the latest trigger, and a request that never answers does not hold back the next one.

### What counts as a build

A build is the boot graph the served index assigns to `__DSH_BOOT__` — every client plugin by id with its revision, compared as a set, so the order the graph lists them in plays no part — plus the URLs of the index's module scripts under its base directory, which name the web shell's bundle by its build hash. A module script from anywhere else, such as one a browser extension adds to the page, is part of no build. The page captures its own build once, when the plugin starts. A plugin revision derives from its bundle file's size and timestamps, so a restart that serves the same files serves the same build, while a rebuild or an upgrade does not.

Each check requests the address the document was served from — the navigation entry's URL without its fragment — with `cache: 'no-store'`, `redirect: 'manual'`, and the page's own cookies. Only a `200` answer of type `text/html` carrying the exact boot graph markup the host renders, with a valid entry list that includes this plugin, is a build. Every other answer — a refusal such as the `401` of an expired browser session, a redirect, a network failure, another content type, a missing or malformed boot graph, a graph without this plugin — is no evidence of anything: the page neither reloads nor shows a notice, and the reason goes to the debug log.

### What a different build does

The page records the build it is reloading for in this tab's session storage under `dsh-page-refresh:reloaded-for`, then reloads, after `reloadDelayMs` when that is positive. A later check that finds the build it recorded — the reload did not bring the page onto it — offers the reload in the banner instead of performing it, and so does a tab that may not read or write session storage. A check that finds the build the page booted with clears the record and withdraws the offer. The composer's text draft survives the reload: it is written to local storage on each edit and restored with the selected conversation.

### The banner

One entry in the shell's frame-wide `shell.overlay` slot, drawn at the top centre of the page, clear of the composer. It shows one notice at a time, the build notices ahead of the connection notices:

| Notice | Chinese | English |
|---|---|---|
| Different build, reload offered | 页面有新版本，请刷新后继续使用 + 刷新页面 | A new version is available. Reload the page to continue. + Reload page |
| Reload delayed by `reloadDelayMs` | 正在刷新页面… | Reloading… |
| Connection lost for longer than 800 ms | 连接已断开，正在重新连接… | Connection lost, reconnecting… |
| Reconnected after a shown loss, for 2 seconds | 已重新连接 | Reconnected |
| Lost for `stuckAfterSeconds` while the browser is online | 暂时连不上服务 + 刷新页面 | Can't reach the service + Reload page |

Only a loss after the page has been connected counts. While the browser reports itself offline, the notice stays on reconnecting. The build check and the connection notices depend on the connection service alone; the banner waits separately for the slot and locale services, so a page whose React tree failed to draw still checks its build and still reloads.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The node half validates the four fields and pushes them into every rendered index as the `__DSH_PAGE_REFRESH_CONFIG__` global through `webserver/index-inject`, because a browser half receives no cordis config. It registers no route: a reverse proxy in front of a console may forward only the shell's own exact paths to this process, and the build check reads the index itself. The browser half validates that global before doing anything; a missing or out-of-range global fails the boot of the whole page, not only this row (see [Known Limitations](#known-limitations-and-deferred-work)).

Every impure operation of the browser half — the navigation entry, the boot global, the index request, session storage, the reload, timers, visibility, and network events — goes through one interface whose production implementation is bound to `window`, so the check and the notices run against a page a test assembles.

| File | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Node half: `Config` and the settings global |
| [`src/config.ts`](src/config.ts) | The global's name and the timer bounds both halves share |
| [`src/client/index.ts`](src/client/index.ts) | Browser plugin body |
| [`src/client/install.ts`](src/client/install.ts) | Wires the check, the notices, and the banner into one context |
| [`src/client/identity.ts`](src/client/identity.ts) | What a build is and how one is read out of a served index |
| [`src/client/check.ts`](src/client/check.ts) | The build check and its reload guard |
| [`src/client/notice.ts`](src/client/notice.ts) | The connection notices |
| [`src/client/browser.ts`](src/client/browser.ts) | The page operations |
| [`src/client/PageRefreshBanner.tsx`](src/client/PageRefreshBanner.tsx) | The banner |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Agent Note](../../../.agents/notes/implemented/architecture/2026-10-02-console-reloads-on-a-new-build.md) — why the console reloads instead of replacing plugins live.
- [`dsh-experimental-console-profile`](../console-profile/README.md) — the composition that mounts this row.
- [`dsh-client-hmr`](../../client/hmr/README.md) — the live plugin replacement the console turns off.
- [`dsh-client-modules`](../../client/modules/README.md) — the boot graph the build is read from.
- [`dsh-experimental-server-layout`](../server-layout/README.md) — the console shell whose overlay layer draws the banner.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package registers no tool, prompt section, or result: its node half adds one settings global to the HTML a browser is served, and its browser half reloads the page and draws a banner, all outside any model request.

#### KV Cache effect

Independent: this package issues no model request and adds nothing to one, so no request prefix changes and no already-reusable prefix is invalidated.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The constraints below hold for every composition of this row.

- **A page opened before this row was composed does not carry it.** Such a page keeps running its client after an upgrade and needs one reload by hand; every page loaded after that carries the check.
- **Unsent attachments are lost on the automatic reload.** The text draft survives, but images and files attached to an unsent message are browser objects that no storage keeps, and the check does not defer the reload for them.
- **A refused or redirected index leaves the page on its old client.** An index answered `401` because the browser session cookie expired, or redirected by something in front of the process, is no evidence of a build, so the page neither reloads nor offers a reload; the visitor's next reload by hand is what recovers it.
- **A rebuild with unchanged content still reloads open pages.** A plugin revision derives from its bundle file's size and timestamps, not its content, so restarting after any rebuild counts as a different build.
- **Building in the running tree reloads a page early onto a mixed build.** With `client-hmr` off, a running host keeps serving the plugin bundles it loaded at start, while it reads the shell's index from disk on every request. A build in the tree a running server serves therefore makes the next check reload the page onto the new shell with the old plugin bundles, and the restart onto the new build reloads it a second time. Build into a separate tree and switch to it at the restart, as the image deployment does.
- **Removing this row or renaming its package needs one reload by hand.** The check looks in the served graph for the package name the page's client was built with. A graph that does not list it is no evidence of a build, because a host that is still composing its plugins serves one too; open pages therefore neither reload nor offer a reload when a deployment drops the row or a build lists this plugin under another package name.
- **A config the host rejects fails every page's boot, not the host.** The node half validates the row's config when the host starts. A rejected value leaves that half inactive, and because a host does not need this row to start, it reports the failure only as a startup warning on stderr, which carries the validation error. The boot graph still lists the browser half while the index carries no settings global, so the browser half's activation fails, and with it the boot of every page the host serves; the browser's error names the missing global and the node half that publishes it.
- **The offered reload needs the banner.** On a page whose React tree failed to draw, the automatic reload still runs, but the offer that replaces it — the second time for one build, or without session storage — is not visible.
- **Not covered by an assembled snapshot** — the evidence is this package's unit suites, its real-composition suite against the web server's index render, the `page-refresh` web scenario, and the console case of the `server-sidebar` web scenario; the snapshot lanes replay the shipped composition, which does not compose an experimental row.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
