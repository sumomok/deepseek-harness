# Agent Note: Re-vendoring apps/desktop-server's third-party plugins off the retired client runtime

Status: implemented

English | [中文](2026-09-01-desktop-server-vendored-plugins-off-client-runtime.zh.md)

## Problem

`apps/desktop-server`'s nine `vendor/*.tgz` third-party plugins (`@haoran/dsh-clickable-refs`, `@haoran/dsh-connection-banner`, `@haoran/dsh-default-model`, `@haoran/dsh-llm-permission-gateway`, `@haoran/dsh-plugin-updates`, `@haoran/dsh-screenshot`, `@haoran/dsh-vision-switch`, `@sumomok/dsh-balance`, `@sumomok/dsh-quote-message`) were built against `@deepseek-ai/dsh-client-runtime`, which the rc.26 upstream sync (0.1.2-alpha.2) removed outright — its surface split into `@deepseek-ai/dsh-api-session-controller` and other packages. `pnpm-workspace.yaml` carried a temporary `overrides` entry pinning `@deepseek-ai/dsh-client-runtime` to `0.1.1-rc.2` (the last real registry version under the old name) so `pnpm install` would not fail resolving these plugins' declared `>=0.1.0-rc.1 <0.2.0-0` optional peer — a bridge the override's own comment already flagged as temporary, with "re-vendoring those tarballs against the new package names is tracked separately."

## Decision

Seven of the nine plugins (all but `@haoran/dsh-default-model` and `@haoran/dsh-llm-permission-gateway`, which never depended on `dsh-client-runtime`) were fixed at the source in the separate `dsh-plugins` repository, each on its own version bump and commit, then re-packed and re-vendored here:

| Plugin | New version | Tarball sha256 |
|---|---|---|
| `@haoran/dsh-clickable-refs` | 0.4.0 | `cd62d5d398d23a253acda05887d08b2085e066eeec18a6eb72f82343e073ad22` |
| `@haoran/dsh-connection-banner` | 0.2.0 | `4f0a9c9bfa33ce62fdd5ffc9398a0f049ee661ebc431b31b82cdade88b959a01` |
| `@haoran/dsh-plugin-updates` | 0.2.0 | `889947266b84f00c7ba9bae9fe0d22cbbc0fab5fa12855bf1a7c9b7ca862233c` |
| `@haoran/dsh-screenshot` | 0.5.0 | `b95846bcc20d2313bbc7c9c9aedbf0896f0fc2a92c2302dee5c54e8f797d8269` |
| `@haoran/dsh-vision-switch` | 0.2.0 | `660e9ce0e8ff643b4b8def0b2c86423fc404789117eb695ae388eff8c46ac485` |
| `@sumomok/dsh-balance` | 0.3.2 | `06a802c91b59eb403f91bcb22656930278792cc1dc81ca9bb204dcac97c0beb7` |
| `@sumomok/dsh-quote-message` | 0.3.0 | `33c8f5fe27e4ace8e0d1f42423d938ffd05a8936fa07d8ebf61862ecbcd2b21e` |

None of the seven declares `@deepseek-ai/dsh-client-runtime` anywhere in its manifest any more (peer, dev, or `dsh.client.inject`); each moved onto the real successor package for whatever it actually used — `@deepseek-ai/dsh-api-session-controller/client` for `ISessions`/`UseProjection`/the durable per-session `modelSelection` projection, `@deepseek-ai/dsh-client-ui-conversation/client` for the composer-chain's now-singular `pendingInteraction`, `@deepseek-ai/dsh-client-ui-user-questions/client` for the pending-question carrier, and `@deepseek-ai/dsh-client-ui-settings/client` for `SettingsScope`. `apps/desktop-server/vendor/` now holds the seven new tarballs (old versions deleted, not kept alongside), `apps/desktop-server/package.json`'s `file:./vendor/...` dependency strings point at the new filenames, and `scripts/gen-third-party-notices.ts`'s hardcoded vendor-tarball paths (and the `THIRD_PARTY_NOTICES.md` it generates) were updated to match.

The `@deepseek-ai/dsh-client-runtime` override is removed from `pnpm-workspace.yaml`. `pnpm install` succeeds with zero `ERR_PNPM_NO_MATCHING_VERSION`.

## Two out-of-scope plugins still pull the retired name in

`pnpm why @deepseek-ai/dsh-client-runtime` is not empty: `dsh-at-file` (a GitHub-release-tarball dependency, peer `*`) and `dsh-better-sidebar` (an npm dependency, peer `^0.1.0-rc.8`) both still declare an optional peer on the retired package name in their own published manifests. Neither is one of the nine `apps/desktop-server/vendor/*.tgz` third-party plugins this decision covers — both are separately-maintained upstream projects reached through their own install mechanism (GitHub ref / registry version), not vendored tarballs this repository builds. With the override gone, pnpm resolves both peers to the real, still-published `0.1.1-rc.2` on its own; the install succeeds and no source in this repository imports anything from that resolved package, exactly as the retired override's own comment already established for the reference confined to shipped `.d.ts` files. Re-vendoring or otherwise fixing these two plugins' own declared peer is out of scope here and untracked by this note.

## Alternatives considered

**Keep a narrower override scoped only to the two remaining consumers.** Rejected for now: the override was pinning a version already satisfied by ordinary registry resolution once the seven in-scope plugins stopped needing it, so an override would be pure redundancy rather than a fix for anything broken. If `dsh-at-file` or `dsh-better-sidebar` is re-vendored later and that resolution stops working cleanly, reintroducing a scoped override at that point is the right next step, not one taken preemptively here.

**Re-vendor `dsh-at-file`/`dsh-better-sidebar` in the same pass.** Rejected: both are third-party projects outside this repository and outside `dsh-plugins`, with their own release cadence; fixing their peer declaration requires a change in their own source, not this repository's.

## Consequences

The temporary bridge is gone: `apps/desktop-server` now depends on real, current package names throughout its nine vendored plugins, with no workspace-wide override standing in for a package `pnpm-workspace.yaml`'s own comment already called out as retired. The cost is the two residual `dsh-client-runtime` peer references from unrelated third-party plugins, which this decision knowingly leaves in place — they resolve harmlessly today, and revisiting them is a separate, later re-vendoring decision for those two plugins specifically, not a gap in this one.
