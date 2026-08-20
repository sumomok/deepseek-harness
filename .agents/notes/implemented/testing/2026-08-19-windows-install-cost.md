# Agent Note: What a Windows install spends its time on, and two ways of measuring that were wrong

Status: implemented

English | [中文](2026-08-19-windows-install-cost.zh.md)

## Problem

Removing the old install by [renaming it aside](../bug-fix/2026-08-19-windows-update-max-path-uninstall-loop.md) deletes the whole directory and extracts a fresh one, which reads as wasteful: a version bump usually changes a small fraction of the payload, and the installer rewrites all 12452 files of it. The question is whether the removal is what makes a Windows install slow, and it is worth answering with numbers because the two obvious answers point at different fixes — optimise the removal, or leave it alone and attack the payload.

Two attempts to answer it produced numbers that looked fine and were not.

## Decision

The removal is not the cost. Measured against the real installer, with an observer cheap enough not to change the answer:

| phase | fresh install | over-install | difference |
|---|---|---|---|
| launch → directory page | 2.86 s | 13.85 s | +10.99 s |
| "installing" → "install complete" | 53.56 s | 58.72 s | **+5.16 s** |

Both runs used the same installer, the same target directory, and the same observer; the operator's clicks fall outside both intervals. Every figure here comes from one NVMe device — C:, D:, E: and F: are partitions of a single ZHITAI TiPlus5000 — so "cross-volume" throughout means a filesystem boundary and not a second spindle. That distinction does not touch the MAX_PATH fault, which is about `MoveFile` semantics across volumes rather than devices, but it does mean none of these timings say anything about a mechanical disk. Removing the old version costs **5.16 s of a 58.72 s install — 8.8%**, and that figure already includes the whole-directory rename, the delete of the staged tree, and the old uninstaller's own registry and shortcut work. Extraction and writing are the other 91%.

The 11 s that separates the two directory pages is not the install being slower. It is `customInit`'s process sweep waiting in `.onInit` for a running app to quit before it tree-kills anything, a `dshQuitGraceSeconds` of 10 by design. It is paid only when someone starts an installer by hand while the app is up. The in-app update path does not pay it, because the app has already quit itself by then — measured at 3.36 s from `elevate.exe` to the staging rename on a real update.

What the payload costs is its **file count**, not its size. Moving the same 500.9 MB as 12453 files takes 5.67 s; as 10 files it takes 0.12 s. **98% of the copy is per-file overhead** — 0.446 ms to create one and 0.151 ms to delete one — and the byte term is so small that the 4174 MB/s it implies is plainly the file cache rather than the device. Compression settings, and anything else that trades bytes, therefore buy nothing here. On a mechanical disk both terms grow, but the per-file one grows by two orders of magnitude while the per-byte one grows by one, so the same decomposition says the file count matters *more* there, not less — and since removal and extraction are both per-file bound, their ratio survives the change of medium even as both absolute figures multiply.

So the lever is the payload's file count, not the removal, and not anything in this repo's control beyond it. The installer writes the payload three times — the 144 MB archive out of the executable into `%TEMP%`, ~500 MB decompressed beside it, then ~500 MB copied to the install directory, cross-volume when the two differ. That is upstream's design: `extractAppPackage.nsh` stages into `$PLUGINSDIR\7z-out` for atomicity, and the 7z package is what the blockmap differential download is computed against. `APP_BUILD_DIR`, the one-write path that `File /r`s straight into `$OUTDIR`, is reachable only for portable targets (`NsisTarget.js`), there is no hook to replace the extraction, and this repo does not modify upstream.

Download is already solved and is not where to look either. A real rc.12 → rc.13 update reported `Full: 142,014.31 KB, To download: 1,521.69 KB (1%)` — 72 changed blocks, ten seconds from the offer to "downloaded".

## Two measurements that were wrong

**The observer cost more than what it observed.** The first timings came from sampling `Get-ChildItem -Recurse -File` over the install directory every 400 ms. One such walk over this payload costs ~530 ms, so the observer ran at a **133% duty cycle** against the very tree the installer was writing, back to back, with no idle. It reported the file-copy phase as 35.4 s against a real 5.71 s for the equivalent work — inflated roughly sixfold, and worst exactly where the installer was most file-bound. Nothing in the output looked wrong; the phases were ordered sensibly and the run-to-run spread was small.

**The isolated measurement substituted faster tools for the real ones.** The second attempt dropped the observer entirely and timed the phases on their own: `7z.exe x` for the decompression, `robocopy /MT:1` for the copy, three runs each, tight spread. It summed to 22.52 s against the 53.56 s the installer actually takes for the same work — **low by 2.4×**. `7z.exe` decompresses LZMA on multiple threads and `Nsis7z` does not; `CopyFiles` is `SHFileOperation` and carries per-file shell overhead `robocopy` does not; and the 0.03 s for writing a 144 MB archive was the file cache, not a disk. This error is the more dangerous of the two, because low variance across repeated runs reads as precision and there is no signal in the data that the thing being measured is not the thing that ships.

The rule both violate: **an install timing is either of the real installer, or it is a lower bound and says so.** Substituting an equivalent operation for the real implementation is itself an error term, and it does not show up in the variance.

## How to measure it again

Time the installer itself, and observe it only through constant-time calls — whether a process id exists, and what its dialog's static controls say. Both are sub-millisecond. Enumerating windows was never the problem; walking the install directory was.

```
launch installer → mark "process launched"
poll every 250 ms:
  process matching 'DSH Desktop Setup*' present?  → read its #32770 child Static texts
  text changed?                                   → mark it
  process gone, app process back?                 → mark and stop
```

Both harnesses live beside the packaging pipeline: `apps/desktop/scripts/measure/time-run.ps1` times one installer or uninstaller run this way, and `apps/desktop/scripts/measure/shape.ps1` is the per-file/per-byte split. Neither is wired into a gate — they are run by hand when a number is wanted, which is the whole of their contract.

The interval to quote is the one between the "installing" page and the "complete" page. Everything outside it is the operator deciding when to click, and it varied by 30 s between the runs recorded above.

The absolute numbers are warm-cache: the payload had been read minutes earlier, and the install reads back what it has just written to `%TEMP%` in any case, so only the initial read of the installer is cold-sensitive. A genuinely cold figure needs a reboot first, and was not taken.

## Alternatives considered

**Optimise the removal.** The change that prompted the question. At 5.16 s of 58.72 s there is at most 8.8% to win and realistically far less, since most of that interval is the old uninstaller doing registry and shortcut work that has to happen regardless.

**Skip the uninstall and extract over the top.** `CopyFiles` overwrites in place, so the delete could be dropped entirely. Rejected: files the new version no longer ships would accumulate, and stale native modules under `resources/server` are a real failure rather than a tidiness complaint. It buys ~2 s.

**Eliminate the temp staging.** Worth 8.9 s by the isolated measurement — the largest single item after decompression itself. Not available: no hook, portable-only alternative, upstream unmodified, and the staging is what makes the extraction atomic and the differential download possible.

**Hoist the nested `node_modules`.** Considered as a size lever and measured instead of assumed: of the ~1560 files in nested trees, 1059 are `@mistralai/mistralai`, which exists nowhere else, and every one of the five duplicated packages checked is at a **different version** from its top-level twin — nested because it must be. Hoisting saves zero files and zero seconds. It remains worth doing for [the MAX_PATH headroom](../bug-fix/2026-08-19-windows-update-max-path-uninstall-loop.md), which is a different problem.

## Consequences

The removal path stays as it is, and a future reader who finds "delete everything then extract everything" wasteful has the number that says how much: 8.8%, most of it not the delete.

The payload's file count is the standing lever, and it is the one this repo controls. Of the 12452 files, 12426 are the embedded server closure; of those, 11008 (89%) are third-party packages and 1417 are this repo's own, which tsdown already emits as a couple of files each. The pipeline prunes 19274 files today and anything further is a packaging-structure change rather than a setting — [collapsing the closure's third-party trees](../architecture/2026-08-19-self-contained-desktop-closure.md) is where the remaining order of magnitude is.

A manual install started while the app is running pays ~11 s that an in-app update does not. That is the process sweep's grace period, and it is a deliberate trade for not killing a running app outright.

No cold-cache figure exists. The numbers here are the warm case, which is the common one for an update but not for a first install on a machine that has been off.
