# Agent Note: The console compacts automatically at 60%, and withholds both compaction rows from Settings

Status: implemented

English | [中文](2026-10-03-console-auto-compact-and-withheld-compaction-rows.zh.md)

## Problem

A console conversation is a long data session: page reads, component results, and tool output accumulate until a request reaches the edge of the model's context window. The console composed no proactive compaction, so the only floor was the compaction backend's own between-steps pressure check, which retries a failed summary at every following step, and its overflow recovery. The desktop line already ships `@haoran/dsh-auto-compact`, an out-of-repo plugin that compacts between two steps once the next request would pass a share of the window and backs off after one failure per turn; it reads its share through the `compactionPolicy` seat that [`auto-compaction-policy-seat`](2026-09-14-auto-compaction-policy-seat.md) adds to `compaction-basic`.

Two Settings → General rows offered a customer choices the console fixes. `dsh-client-ui-chat`'s "Compaction while busy" row picks when a `/compact` typed during a running turn runs, in vocabulary written for a developer. The auto-compact plugin brings its own switch-and-slider row, a percentage of a context window. `ui-chat` cannot be disabled, because it draws the Chat column, and both rows are registered by packages that stay composed.

The console's Agent presets mount `compaction-basic` inside an isolated `compaction` group, so the engine is invisible to a host-plane row's injection.

## Decision

**The console bundle composes `@haoran/dsh-auto-compact` 0.5.1 with `enabled: true` and `thresholdPercent: 60`.** The row sits in [`cordis.patch.yml`](../../../../packages/experimental/console-profile/cordis.patch.yml), the bundle layer, below the profile patch: both fields are volatile, so 60% is the inherited value and a settings write saved into the profile patch outranks it. The plugin is a host-plane row and finds each agent's engine through `ctx.agentPresets.serviceFor(agent, 'compaction')`, which reaches the `compaction` group of the `console` preset and of its `standard` twin; once it reaches one, its `compactionPolicy` answers `isEnabled(): false` and `compaction-basic` stands its own between-steps check down. Overflow recovery is unchanged.

**The plugin arrives as a vendored tarball.** `console-profile` declares `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"`, the form `component-kit` uses for its tarballs. The tarball is packed from a build of a clean copy of the plugin repository's pushed `main`. The package declares its harness packages as optional peers; `console-profile` lists `@deepseek-ai/schemastery`, which the plugin imports at runtime, under `dependencies`, and the type-only peers under `devDependencies`, so the workspace install links every peer to the workspace copy.

**Both rows are withheld by shadowing their list ids.** `settings.general.item` is a list slot whose cell is the entry id, and only the cell's lowest-priority entry renders. `server-sidebar`'s [`settings-rows.ts`](../../../../packages/experimental/server-sidebar/src/client/settings-rows.ts) registers an entry that renders nothing at priority -1 under `busy-compaction` and `auto-compact`, so the owning rows at the default priority 0 never mount. Both packages keep their Config: `busyCompaction` stays at its default, `turn-end`, and automatic compaction runs at 60%. The compaction row a running compaction draws in the conversation belongs to the harness ([`auto-compaction-running-card`](2026-09-18-auto-compaction-running-card.md)) and still shows.

## Alternatives considered

**Disabling `ui-chat` to remove its row.** The package draws the Chat column; disabling it removes the conversation.

**Hiding the rows with the terminology guard's CSS.** A rule couples to rendered class names and leaves the slider in the DOM, focusable by keyboard. A shadowing entry couples to the list id alone, and the row never mounts.

**Composing the `auto-compact` row in the lock overlay.** Above the profile patch, config-editor refuses every write to the two fields, so a deployment could change the share only by editing the lock. The bundle-layer value keeps 60% as the console's default while the profile patch can still carry a deployment's own share.

**Leaving the plugin's row on the page.** A customer would be offered a percentage of a context window, a figure with no meaning in the console's vocabulary, for a value the deployment has already chosen.

**Packing the plugin from its working checkout.** That checkout's `lib/` was built from an older source tree (`THRESHOLD_MIN_PERCENT = 20`, and an idle-compaction module 0.5.1 no longer has) while its sources and manifest were 0.5.1, and `pnpm pack` packs `lib/` as it finds it. The tarball would have carried the older code under the 0.5.1 version.

**`link:` to the plugin repository.** A linked package resolves its own `@deepseek-ai/cordis`, and a second Cordis breaks service identity.

**Leaving the peers undeclared.** pnpm then resolved the missing optional peers from the registry and installed a second set of published harness packages beside the workspace ones.

## Consequences

A console conversation is compacted before the request that would pass 60% of the window, or earlier on a model whose window minus reserved output and the backend's headroom is smaller; a failed attempt is not repeated within the same turn. The model reads long tool results cut to their start and end and, when that is not enough, a summary of the older history from that step on.

The page offers no control for either setting. `busyCompaction`, `enabled`, and `thresholdPercent` remain volatile, so the `remote.settings` method still accepts a write to them from any browser the deployment admits.

The tarball is refreshed by hand: a new plugin version means building a clean copy, packing it, replacing the file, and updating the `file:` specifier, `tests/profile.spec.ts`, and the archive path the third-party notices name (`OVERRIDES` in `scripts/gen-third-party-notices.ts`, registered under the `vendored-component-kit-gates` core-patch record). The Web e2e harness computes its runtime resolution before it installs the profile's bundles, so `apps/web/tests/server-sidebar.e2e.ts` links the unpacked copy into its profile the way it links the experimental packages.

An id the owning package renames is no longer shadowed, and its row returns; the console e2e scenario checks an open Settings page for both rows' text. The Settings header's open-configuration-file action (`settings.action`, id `open-document`) is still hidden by the terminology guard's CSS rule.
