# Agent Note: The console compacts automatically at 60%, and shadows three Settings entries a customer must not use

Status: implemented

English | [中文](2026-10-03-console-auto-compact-and-withheld-compaction-rows.zh.md)

## Problem

A console conversation is a long data session: page reads, component results, and tool output accumulate until a request reaches the edge of the model's context window. The console composed no proactive compaction, so the only protection was the compaction backend's own between-steps pressure check, which retries a failed summary at every following step, and its overflow recovery. The desktop line already ships `@haoran/dsh-auto-compact`, an out-of-repo plugin that compacts before a model request once that request would pass a share of the window, and backs off after one failure per turn; it reads its share through the `compactionPolicy` seat that [`auto-compaction-policy-seat`](2026-09-14-auto-compaction-policy-seat.md) adds to `compaction-basic`.

Two Settings → General rows offered a customer choices the console fixes. `dsh-client-ui-chat`'s "Compaction while busy" row picks when a `/compact` typed during a running turn runs, in vocabulary written for a developer. The auto-compact plugin brings its own switch-and-slider row, a percentage of a context window. The Settings header carried a third entry, `ui-settings-general`'s **Open configuration file** action, which the console's `ownsHost` makes real for every visitor its login gate admits; [`console-mcp-default-and-settings-trim`](../architecture/2026-09-20-console-mcp-default-and-settings-trim.md) hid it with a CSS rule, on the reading that a list slot admits no withdrawal by another plugin. `ui-chat` cannot be disabled, because it draws the Chat column, and all three entries are registered by packages that stay composed.

The console's Agent presets mount `compaction-basic` inside an isolated `compaction` group, so the engine is invisible to a host-plane row's injection.

## Decision

**The console bundle composes `@haoran/dsh-auto-compact` 0.5.1 with `enabled: true` and `thresholdPercent: 60`.** The row sits in [`cordis.patch.yml`](../../../../packages/experimental/console-profile/cordis.patch.yml), the bundle layer, below the profile patch: both fields are volatile, so 60% is the inherited value and a settings write saved into the profile patch outranks it. The plugin is a host-plane row and finds each agent's engine through `ctx.agentPresets.serviceFor(agent, 'compaction')`, which reaches the `compaction` group of the `console` preset and of its `standard` twin; once it reaches one, its `compactionPolicy` answers `isEnabled(): false` and `compaction-basic` turns off its own between-steps check. The plugin's check runs before each model request of a turn, the first included. Overflow recovery is unchanged.

**The plugin arrives as a vendored tarball.** `console-profile` declares `"@haoran/dsh-auto-compact": "file:./vendor/haoran-dsh-auto-compact-0.5.1.tgz"`, the form `component-kit` uses for its tarballs. The tarball is packed from a build of a clean copy of the plugin repository's pushed `main`. The package declares its harness packages as optional peers; `console-profile` lists `@deepseek-ai/schemastery`, which the plugin imports at runtime, under `dependencies`, and the type-only peers under `devDependencies`, so the workspace install links every peer to the workspace copy.

**Three Settings entries are withheld by shadowing their list ids.** `settings.general.item` and `settings.action` are list slots whose cell is the entry id, and only the cell's lowest-priority entry renders. `server-sidebar`'s [`settings-entries.ts`](../../../../packages/experimental/server-sidebar/src/client/settings-entries.ts) registers an entry that renders nothing at priority -1 under `busy-compaction`, `auto-compact`, and `open-document`, so the owning entries at the default priority 0 never mount; this replaces the CSS rule for the configuration-file action. The packages keep their Config: `busyCompaction` stays at its default, `turn-end`, and automatic compaction runs at 60%. The rows a compaction draws in the conversation belong to `ui-chat`, the running one through [`auto-compaction-running-card`](2026-09-18-auto-compaction-running-card.md), and the console replaces none of them.

## Alternatives considered

**Disabling `ui-chat` to remove its row.** The package draws the Chat column; disabling it removes the conversation.

**Hiding the entries with the terminology guard's CSS.** A rule couples to rendered class names and leaves the control in the DOM, focusable by keyboard. A shadowing entry couples to the list id alone, and the control never mounts.

**Composing the `auto-compact` row in the lock overlay.** Above the profile patch, config-editor refuses every write to the two fields, so a deployment could change the share only by editing the lock. The bundle-layer value keeps 60% as the console's default while the profile patch can still carry a deployment's own share.

**Leaving the plugin's row on the page.** A customer would be offered a percentage of a context window, a figure with no meaning in the console's vocabulary, for a value the deployment has already chosen.

**Packing the plugin from a working checkout.** `pnpm pack` packs `lib/` as it finds it, and a checkout's `lib/` can be older than its sources and manifest, so the tarball would carry older code under the newer version. The tarball is packed from a build of a clean copy of a pushed commit.

**`link:` to the plugin repository.** A linked package resolves its own `@deepseek-ai/cordis`, and a second Cordis breaks service identity.

**Leaving the peers undeclared.** pnpm resolves missing optional peers from the registry and installs a second set of published harness packages beside the workspace ones.

## Consequences

A console conversation is compacted before a model request that would take more than 60% of the window, the first request of a turn included, or earlier on a model whose window minus reserved output and the backend's headroom is smaller; a failed attempt is not repeated within the same turn. From that request on, the model reads long tool results cut to their start and end and, when that is not enough, a summary of the older history.

What a customer sees of a compaction is `ui-chat`'s: 正在压缩… while it runs; then, among the turn's process rows, the marker 上下文已压缩 · 已压缩 N 条历史记录（约 N tokens）, which expands to the summary `compaction-basic` wrote in English, as its summarizer prompt asks; or 上下文压缩失败 as a row of its own when the summary fails. The persona's Chinese-only line does not reach that summary, and the marker shows a token count that `performanceUsage: compact` removes from completed answers. `conversation.chat.node` is a keyed slot, so a console entry at priority -1 under the `compaction` and `compaction-failure` keys could replace both rows without a core patch.

The page offers no control for the three settings. `busyCompaction`, `enabled`, and `thresholdPercent` remain volatile, so the `remote.settings` method still accepts a write to them from any browser the deployment admits.

The tarball is refreshed by hand: a new plugin version means building a clean copy, packing it, replacing the file, and updating the `file:` specifier, `tests/profile.spec.ts`, and the archive path the third-party notices name (`OVERRIDES` in `scripts/gen-third-party-notices.ts`, registered under the `console-vendored-plugin-notice` core-patch record). The Web e2e harness computes its runtime resolution before it installs the profile's bundles, so `apps/web/tests/server-sidebar.e2e.ts` links the unpacked copy into its profile the way it links the experimental packages.

The `console-auto-compact` Web snapshot pins the behavior. An authored conversation replayed through the console composition on a 200,000-token window compacts before the third turn's first request once the second reply reports 62.5% of the window, which the backend's own check would let pass: it triggers at the lesser of 80% of the window and the window minus its headroom, 134,464 tokens here; a keyless run at 57.5% compacts nothing, and the `standard` twin compacts at 62.5%. The same snapshot pins the console composition's system prompt and tool schemas.

An id the owning package renames is no longer shadowed, and its entry returns; the console e2e scenario checks an open Settings page for the two rows' text and for an empty header action row.
