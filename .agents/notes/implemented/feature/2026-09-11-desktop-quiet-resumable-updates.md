# Agent Note: The desktop update is quiet, resumable, and installed only on a click

Status: implemented

English | [中文](2026-09-11-desktop-quiet-resumable-updates.zh.md)

## Problem

The update flow read as mandatory even though no install ever happened without a click.

Three surfaces produced that reading, and none of them was asked for. A silent check that found a new version opened a modal offering the download. Accepting it opened a 440×200 window that showed itself and took focus, and set taskbar or Dock progress for the whole transfer. The moment the transfer finished, a second modal asked whether to restart now — arriving in the middle of whatever the user was doing, after a Dock bounce or a flashing taskbar button, and requiring an answer before the session could continue. The default button was 「暂不」, but a question that must be answered to get back to work is not experienced as optional.

Underneath that, the transfer itself could not be relied on. electron-updater sends no `Range` header on a full download and unlinks the partial file on any error (`AppUpdater.executeDownload` → `removeFileIfAny`), so every attempt re-transfers the whole artifact — 170 MB for this product's macOS build, and the whole artifact again on a machine whose first in-place update cannot be differential. [The retry plan](../bug-fix/2026-08-21-desktop-update-download-retry.md) bounded the cost of an interruption at three more full attempts over 26 seconds, which covers a Wi-Fi handover and does not cover an evening on a connection that drops every few minutes.

The two problems are one problem: a transfer may only be quiet if it can afford to take as long as it takes.

## Decision

The transfer is invisible and resumable; the only visible state is an update that is downloaded, verified, and one click from being installed.

### Nothing about a download reaches the screen

A check — 15 s after launch, every four hours, from 帮助 → 检查更新, and from the Settings entry — starts the transfer of whatever it finds without asking. `offerDownload` and the non-blocking half of `offerInstall` are gone with the module state that supported them (`declinedVersion`, `postponedVersion`); so are `showProgress`, `showRetrying`, `updateProgress`, `closeProgress` and `mainWindow()?.setProgressBar(...)`. `progress-window.ts` keeps only the macOS installing notice, which is the one moment the app owes an explanation: Squirrel takes the screen for around fifteen seconds and a force-quit in that window lands where the bundle is half replaced.

帮助 → 检查更新 keeps its place and its label because a menu item that vanishes is a feature nobody can find again. It runs the same silent check and answers only 「已是最新版本」 or 「无法检查更新」: a click deserves a reply, and both of those are the reply. A check that found work answers where the update lives instead, because a dialog saying "downloading" is the interruption this change removed.

### The state is a machine, and the Settings window is where it is shown

`update-state.ts` holds `idle | checking | downloading | ready | failed` and one snapshot, with no electron in it. Two states refuse to be moved: `ready` survives every later check, so a scheduled check cannot take a finished update back off the screen, and the `failed` that `markUnavailable` sets is final for the run, because a build that cannot install what it downloads — a source-tree launch, or a macOS bundle whose in-place path failed — has nothing further worth reporting as progress towards an install that cannot happen.

Five phases is the whole set, and there is deliberately no sixth for "this deployment has no update channel". A reader that needs that value owns it: a `dsh web` on a server finds no endpoint in its environment and answers for itself, while the shell only ever answers for a channel it has. `checkedAt` is an ISO 8601 string rather than epoch milliseconds, and `downloading` carries `percent` alongside `transferredBytes`/`totalBytes` rather than either alone, so a reader is never obliged to derive one from the other.

`update-service.ts` is the third loopback listener beside the render and plugin-admin ones, opened and passed exactly as they are: `127.0.0.1` on an ephemeral port, a 32-byte token compared in constant time, both reaching the server child's environment alone as `DSH_DESKTOP_UPDATE_ENDPOINT` and `DSH_DESKTOP_UPDATE_TOKEN`. It has a token of its own because it lends the heaviest power of the three: `/install` replaces the whole application, where the render token buys pixels and the plugin-admin token buys a package install. Four routes — `GET /state`, `POST /check`, `POST /download`, `POST /install` — with no request body; `apps/desktop-shell/README.md` owns the field-by-field snapshot contract, which a plugin in another repository is written against.

**`/install` opens no dialog.** The click in the Settings window is the consent, and a native confirmation would repeat the question that click answered. What protects the route instead is the phase: it is refused outside `ready`, so the only artifact it can install is one whose sha512 already matched the manifest.

It answers before it acts, with `{ "ok": true }` on the wire and the install scheduled for the next tick. The install stops the embedded server and hands the machine to an installer that replaces this process, so a caller still waiting on the response would read the dropped socket as a failed install and report a failure for an update that is being applied.

### The transfer runs in two halves, in that order

`download()` still runs `downloadUpdate()` under the existing backoff first, because that is the half that can fetch a differential update — measured at 12,392 KB of a 170,291 KB artifact between two adjacent releases. Only when the plan is spent does `transferWithFallback` hand the same artifact to `resumable-download.ts`, which asks for `bytes=<have>-` behind an `If-Range` validator, appends to a `.part` file, hashes as it writes, and verifies the finished file against the manifest's base64 sha512. Its own plan is longer and slower — 2 s, 10 s, 30 s, 2 min, 5 min — because each of its attempts costs a request rather than the artifact.

`pending-cache.ts` then stages the verified file at `<cacheDir>/pending/<fileName>` beside the `update-info.json` electron-updater writes there, and the transfer calls `downloadUpdate()` once more. The library validates the cache before it opens a socket (`AppUpdater.js:604-608`), takes the file from there, and emits `update-downloaded` on both platforms with no network I/O — so the install path, `quitAndInstall` included, is the one that was already shipping.

`.part` files are keyed by version and artifact name and live in the cache directory **root**, never in `pending`: any failure inside electron-updater's own download empties `pending`, and that failure is precisely what the resumable half exists to survive. A `.part` left by a version the feed has moved on from is dropped when the next transfer starts.

### The mandatory red line is untouched

`--minimum-version` still downloads without asking, still blocks the launch behind the boot page, and still ends in the single-button 「重启安装」 dialog. It takes **no** resumable fallback: the app is shut until the transfer returns, and a plan that spends minutes resuming would read as a hang where the retry plan's half-minute does not.

## Alternatives considered

**A second confirmation on the install click.** The plugin-admin service requires a native modal before it installs a package, and `/install` does something heavier. It is not the same situation: a package install is requested by a page that a compromised plugin could also draw, while the update button is drawn by the product's own Settings window and says exactly what it does. A confirmation there asks a question one click old, which is the shape of prompt this change set out to remove.

**Leaving 帮助 → 检查更新 to open the old offer dialog.** It would have kept one route to the flow for someone who prefers dialogs, and it would have kept the interruption alive on the one path where a scheduled check reuses the same code. One flow, one behavior.

**Replacing `httpExecutor`, or subclassing `MacUpdater`.** Rejected before, for reasons that have not changed: `httpExecutor` is assigned in the constructor and typed as internal, and `updateDownloaded` is private and reaches into the local proxy server the class owns. Staging a file into the cache directory touches the same private layout but touches it from outside, where a version bump fails loudly rather than silently changing what a subclass overrides.

**Resuming instead of retrying, rather than after it.** A resumable full download of 170 MB is strictly worse than a differential download of 12 MB, and the differential path is electron-updater's. Order matters more than either half.

## Consequences

An update transfers over as many interruptions as it meets, across a session and across restarts, and nobody watching the screen can tell it is happening. What used to cost the session's update channel now costs nothing visible, and the first thing a user hears about an update is that it is ready.

The cost is a hard dependency on electron-updater's private cache layout — the `pending/` directory, the three fields of `update-info.json`, and the `getCacheUpdateFileName()` naming rule — which is not a documented contract. `pnpm patchedDependencies` pins the library at `6.8.9`, so any bump fails the install before it can reach a build; that pin is the sentinel this depends on. Two smaller costs: every `downloadUpdate()` that hits the cache re-hashes the whole artifact (`DownloadedUpdateHelper.js:123`), seconds on a large file, and on Windows the cache short-circuit skips `verifySignature`, which is written inside the download task. This product signs no Windows executable today, so nothing is skipped that would have run — but a build that starts signing must verify the staged file itself, and the README records that as a precondition.

This reverses the alternative [the download-retry note](../bug-fix/2026-08-21-desktop-update-download-retry.md) rejected, on its own terms. That note called a shell-owned resumable downloader "the right answer for a client on a bad connection" and set one condition for building it: field evidence of a measurable share of downloads still failing. The condition is superseded rather than met — the requirement that arrived is a product one, that a download must not be prominent, and a transfer that cannot be resumed cannot be quiet, because every interruption has to be reported and retried where the user can see it. The retry plan itself is unchanged and still runs first; what is new is what happens after it.

`tests/update-state.spec.ts` pins every transition and the two states that refuse to move. `tests/update-service.spec.ts` pins the four routes, the 404-before-401 order, and the refusal to install outside `ready`. `tests/resumable-download.spec.ts` interrupts a local server that honours `Range` and proves the resumed file's sha512, that the request carries the offset and the validator, that a `200` or `416` answer restarts cleanly, and that a digest mismatch discards the part while an interruption keeps it. `tests/pending-cache.spec.ts` runs electron-updater's own `DownloadedUpdateHelper.validateDownloadedPath` against a staged directory, so the handoff is proven by the code that will read it rather than by a restatement of its rules. `tests/download-retry.spec.ts` pins the two halves' ordering with fakes. `updater.ts` imports electron and stays unit-untested; the update channel has no snapshot lane, so its evidence is a packaged build against a live feed.
