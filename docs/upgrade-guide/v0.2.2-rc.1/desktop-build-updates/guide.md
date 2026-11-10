---
kind: upgrade-guide
description: Desktop release commands require explicit build identity and immutable artifact manifests, and updates use build sequences instead of application versions.
---
# Desktop releases use build sequences

English | [中文](guide.zh.md)

## Change

Desktop release operators must supply an explicit build identity. The source and bundled runtime retain the upstream version; `dshRelease.buildSequence` orders desktop updates, including multiple builds of the same version. `revision` identifies the source commit and never orders releases. Re-signing or rebuilding different bytes requires a new sequence.

Legacy clients read the original feed to reach a bridge; bridge and standard clients read `/dsh-updates/v2/{mac,win}`. The migration example is bridge app `0.2.2-rc.4` / runtime `0.2.2-rc.1`, then standard app `0.2.2-rc.1` with larger sequences. These are examples, not published or fixed values; no example sequence is an allocated release. v2 rejects runtime downgrades, conflicting identities at one sequence, and legacy `minimumVersion`.

## Migration

1. Inventory all historical releases: the bridge application version must exceed every legacy version, not just `latest`. Keep source versions synchronized and allocate increasing sequences. Record `version`, `dshRelease` (`schemaVersion: 2`, `runtimeVersion`, `buildSequence`, full Git `revision`, `kind`) and `platforms: ["darwin", "win32"]` or one target in the build input. `kind: bridge` is only for transition; standard application and runtime versions must agree.
2. Use the [packaging commands](../../../../apps/desktop-shell/README.md) to produce final artifacts and their generated release manifest. Do not supply guessed hashes before building or reuse stale staging. Preserve each completed manifest with its exact artifacts; publication accepts that output rather than the build input.
3. Publish the first standard build to v2 before pointing the original feed at the bridge. For each platform, v2 must have a runtime no older than the bridge and a strictly larger build sequence; both publication directions enforce this. Keep the bridge manifest and all legacy dependencies, including historically derived blockmaps, permanently. Keep pruning disabled for this migration. The bridge's lower sequence is allocated first even though its feed pointer becomes public second.
4. Use the [publishing command](../../../../apps/desktop-shell/README.md) with the completed manifest and release notes. v2 uses `--minimum-build-sequence`; v1 uses `--minimum-version`. Omission preserves each platform's existing lower bound. `--republish` retries identical artifacts only; publish a larger sequence to fix changed bytes. `--dry-run` still reads remote state.
5. The release operator must verify real legacy rc.2/rc.3 → bridge → standard build N → same-version build N+1 in isolated macOS and Windows environments before release. Keep the legacy installer unchanged; a Windows per-machine install needs a separate VM or test machine. Verify macOS designated-requirement continuity, running identity, preserved settings, and pending-cache cleanup. A downloaded update or passing unit test does not establish native installation success.

No manual edit of `desktop-state.json` is required. A cleanup receipt names the exact target build and artifact; unrelated builds and legacy receipts do not establish success. Older writers can discard new state fields, leaving cache files for a later download to replace.
