# Agent Note: This fork ships with session telemetry and plugin inventory reporting off

Status: implemented

English | [中文](2026-09-01-fork-kills-session-telemetry-and-plugin-inventory.zh.md)

## Problem

`packages/bundle/base/cordis.patch.yml` (the layer every shipped profile — desktop, web, headless, ACP, SDK — composes over) mounts two rows that each send data to a DeepSeek-operated endpoint by default: `session-telemetry-otel`, configured `mode: FEEDBACK_ONLY` (uploads a session's canonical log the moment a `feedback/record` event lands, overriding the package's own shipped `DISABLED` default), and `plugin-package-inventory-deepseek`, which attaches the active Loader plugin-package inventory to every official-DeepSeek-API LLM request. `packages/bundle/sdk-minimal/cordis.patch.yml` (the standalone SDK bundle, which does not extend `base`) separately mounts its own `plugin-package-inventory-deepseek` row. This fork's own product decision is that no build it ships reports either kind of data, regardless of a user's `DSH_TELEMETRY_MODE`/feedback actions or which profile they run.

## Decision

Both rows in `packages/bundle/base/cordis.patch.yml`, and the `plugin-package-inventory-deepseek` row in `packages/bundle/sdk-minimal/cordis.patch.yml`, now carry `disabled: true`. A disabled Cordis entry's `apply()` never runs, so this is a structural guarantee, not a runtime check: neither plugin ever constructs an HTTP client, an OTel exporter, or a Loader-registry reader, in any profile built from either bundle. The `config` blocks stay declared under `session-telemetry-otel` rather than deleted, so `DSH_TELEMETRY_MODE`/`DSH_TELEMETRY_OTLP_URL` keep documenting what upstream's own row expects, for a downstream consumer of these bundle packages that wants to re-enable it.

`apps/desktop/src/server.ts`'s `startServer` additionally sets `DSH_TELEMETRY_DISABLED: '1'` on the embedded server's spawn environment, spread before `spec.env` so a caller (a test) can still override it. This is redundant with the `disabled: true` row above for the desktop product specifically, deliberately: `DSH_TELEMETRY_DISABLED` is upstream's own existing hard-disable switch (`apps/cli/src/profile-boot.ts`'s `resolveTelemetryPatch`, unconditionally reapplied as the topmost overlay in `composeProfile`'s patch stack, above `--patch` overlays) already covering `session-telemetry-otel` by row id for any composition, patched or not — a second, environment-level guarantee for the one product (desktop) whose own launcher this fork controls directly, independent of which bundle patch happens to be composed underneath it. `DSH_TELEMETRY_DISABLED` has no equivalent effect on `plugin-package-inventory-deepseek`; that row's only off-switch is its own `disabled: true` line.

`packages/bundle/base/tests/base.spec.ts` and `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts` (both already parsing `cordis.patch.yml` through `entryListSchema` for other rows' `disabled`/`config` shape) gained assertions that both rows parse to `disabled: true` in their respective bundle. `apps/desktop/tests/server.spec.ts` gained a scripted-child-process test proving the spawned server sees `DSH_TELEMETRY_DISABLED=1` by default and that an explicit `spec.env` entry still overrides it.

## Alternatives considered

**Rely on `DSH_TELEMETRY_DISABLED` alone, everywhere.** Rejected: the switch is upstream's own opt-out, resolved once inside `apps/cli`'s boot path, and it has no equivalent for `plugin-package-inventory-deepseek` at all. A fork-wide product decision to ship both off belongs in the bundle definition every profile composes from, not in an environment variable a user could unset, and not duplicated by hand into a new environment switch this fork would then have to invent and document for the second plugin.

**A fork-owned overlay bundle patched on top of `dsh-base`, rather than editing `dsh-base` itself.** Considered, since `packages/bundle/base` is upstream-synced source and the fork's own policy prefers customizing at the plugin/composition layer over touching upstream core. Rejected for this specific case: no shipped profile in this repository currently composes any fork-owned overlay bundle at all (every one of `apps/desktop`'s `WEB_TEMPLATE_BUNDLES`, `apps/pwa`, and the SDK/headless/ACP bundles composes pure upstream bundles directly), so introducing one bundle package solely to flip two `disabled` booleans would be new composition-layer machinery for a two-line change, tracked instead as a core patch — the fork's own established path for a "necessary" upstream-source edit, entered in `.claude/core-patches.md` (see the two entries this commit adds) so the next `rc.27`-style sync knows to re-apply it.

## Consequences

Every profile this fork's products can seed — desktop, PWA/web, headless, ACP, the standalone SDK bundle — ships with zero outbound telemetry or plugin-inventory reporting by construction, verified by parsing the actual committed patch files rather than by a live network assertion. The cost is that a future contributor who wants either row back must find and revert two now-nonobvious `disabled: true` lines (documented here and in the core-patches ledger) rather than flipping one environment variable; the trade favors the fork's stated privacy stance over discoverability of the opt-back-in path.
