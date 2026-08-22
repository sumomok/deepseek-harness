# Agent Note: The update feed prunes itself, artifacts and blockmaps at their own depths

Status: implemented

English | [中文](2026-08-22-desktop-feed-retention.zh.md)

## Problem

The update feed gains one build per release and nothing ever took one away, so what kept `/var/www/dsh-updates/{win,mac}` from filling was a person remembering a rule.

The rule exists because the memory failed once. On 2026-08-19 a by-hand cleanup of rc.8–rc.11 deleted each version's artifact **and its `.blockmap`** together, and a missing blockmap breaks nothing loudly: electron-updater falls back to transferring the whole artifact, so the cost is a silent full download for every client still on one of those versions. What came out of that incident — "keep current + previous, artifact and blockmap both" — lived in a memory file and in whoever was running the release, and `apps/desktop/scripts/publish-update.ts` went on deleting nothing.

That rule is also miscalibrated, which reading `electron-updater@6.8.9` rather than assuming settles. In `out/AppUpdater.js`, `differentialDownloadInstaller` always downloads the **new** version's blockmap from the feed, but reads the **old** version's from the client's own cache (`current.blockmap`) and fetches it from the feed only when that file is missing; every completed in-app update copies the new blockmap into that cache, so a client that updated in place already holds it. `out/differentialDownloader/DifferentialDownloader.js` opens the old **artifact** from the local cache (`open(this.options.oldFile, 'r')`), so the feed's copy of an old artifact is never requested during an update at all. `MacUpdater.js` reaches the same `differentialDownloadInstaller`, so this holds on both platforms; [the macOS in-app update note](../feature/2026-08-19-macos-in-app-update-self-signed.md) recorded the feed-fetch half of it as unconditional, which it is not.

So the two files the rule kept in step serve different readers. An old artifact serves a rollback and a manual download, at 138–174 MB each. An old blockmap serves a client whose cached copy is gone, at 145–181 KB each. One depth for both pays the artifact's price for the blockmap's benefit, whichever depth is chosen.

## Decision

A publish prunes the channels it just published, to two windows: artifacts of the newest `KEPT_ARTIFACT_VERSIONS = 2` versions, blockmaps of the newest `KEPT_BLOCKMAP_VERSIONS = 10`.

**Two is rollback depth.** An old artifact is never fetched during an update, so its only readers are someone reinstalling the previous build by hand and a rollback that puts the previous manifest back. One version back covers both, and a third version costs another ~170 MB of disk to serve a build nothing points at.

**Ten is cheap insurance.** A blockmap is fetched from the feed only by a client whose cached `current.blockmap` is gone — a fresh install, a cleared cache, a manual reinstall — and losing that fetch costs a full download rather than an error. Ten versions is under 2 MB in total, which is a window several release cycles deep for clients that skipped some builds, at roughly one percent of what the same depth in artifacts would cost.

### The decision is a pure function; only the deleting needs a server

`apps/desktop/scripts/prune-feed.ts` holds both constants and `selectPrunable(names, publishedVersion, publishedNames)`, which sorts every entry of one channel directory into `keep`, `unparsed`, `deleteArtifacts`, and `deleteBlockmaps` — exactly one group per name, which is what the log then prints. `publish-update.ts` lists the directory with `ls -1`, calls it, logs the whole decision, and only then deletes: one `rm -f --` naming each file explicitly, quoted through the `remote()` and `shellQuote()` helpers the uploads already use.

Names are recognized by substituting the version out of the artifact names this publish uploaded — the same substitution electron-updater's `Provider.getBlockMapFiles` performs to address another version's files — so what the prune can see is this channel's own artifacts and blockmaps and nothing else.

### What is never a deletion candidate

- **Anything this publish uploaded or rewrote**, which holds even if the directory somehow carries versions above the one being published.
- **`latest.yml` and `latest-mac.yml`**, excluded by name rather than by whatever the parse happens to decide, because deleting a manifest takes the channel down.
- **A name no template reads** — a dmg, a note file, anything hand-copied. It lands in `unparsed`, is logged as left alone, and is never guessed at.
- **A name whose version does not parse.** `DSH Desktop Setup nightly.exe` fits the template's shape and is still not a version, so it is `unparsed` too.

Versions are ordered by `compareVersions` from `apps/desktop/src/version-order.ts`, never by string comparison: lexicographically `0.1.0-rc.9` sorts above `0.1.0-rc.10`, which would keep the older build and delete the one clients are about to update from. `apps/desktop/tests/prune-feed.spec.ts` pins that case on both windows.

### When it runs, and what a failure costs

The prune runs after both manifests have been read back from the feed serving the new version. Until that point every artifact a client can be told to fetch is still going up, and deleting anything would only mean damaging the publish in flight; past it, the publish has already succeeded and a prune has nothing to undo. Each channel prunes independently and a failure in one is reported and stepped over — the feed then keeps one more version of backlog and the next publish tries again. `--no-prune` skips the step; `--dry-run` prints exactly what would go and what would stay, and deletes nothing.

## Alternatives considered

**Keep the by-hand rule.** It is free and it already failed once, taking four versions' blockmaps with it. The discipline lived in a memory file rather than in the script that does the publishing, so it protected only the releases run by someone who had read that file recently — and the failure it guards against is silent, so nothing would report the next lapse either.

**Keep artifacts and blockmaps to the same depth.** This is what the by-hand rule said, and it is the reason to write this note rather than automate that rule: the two files are read by different code paths on different occasions. Matching the blockmap window to the artifact window pays ~170 MB per version for what 180 KB buys; matching the artifact window to the blockmap window keeps 1.7 GB of builds nothing fetches.

**Keep every blockmap forever.** Bounded per release and unbounded over time, for a benefit that decays: the further back a client is, the more likely it has updated since — filling its cache — or reinstalled outright, and the smaller the differential saving from a blockmap that old. A window that ends is the same protection with an end to the growth.

**Delete nothing and let the disk fill.** The status quo, and it is not stable — each release adds ~320 MB across the two channels, and the failure mode is a publish that runs out of space partway through, on the shared host that also serves the feed. Cleaning up at that point is the by-hand deletion this note exists to remove, performed under pressure.

## Consequences

Rollback reaches exactly one version back. Putting a manifest older than that back on the feed now means re-uploading its artifact, which the build directory or a rebuild still has; before this change any published version could be restored by editing manifests alone.

A client more than ten versions behind that has also lost its cached `current.blockmap` downloads the whole artifact rather than a differential. It does so silently, with a log line on the client and nothing on the server — exactly as it does today when the blockmap is present but the cache is warm and the network drops the fetch. Nothing about the failure mode is new; the window bounds how far back it can be reached.

`apps/desktop/tests/prune-feed.spec.ts` pins both windows, the rc.9/rc.10 ordering trap on artifacts and on blockmaps, that a blockmap survives its own artifact's removal, that published names and manifests are never selected, that an unparsable name lands in `unparsed`, that a directory holding fewer versions than either window deletes nothing, and that every input name is accounted for exactly once. The `rm` itself has no test: it is one ssh command against a live feed, and the publish path has no harness — its evidence is a real release, where the dry run prints the plan before anything is trusted with it.
