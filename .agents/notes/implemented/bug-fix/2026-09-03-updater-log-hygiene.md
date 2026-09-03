# Agent Note: Keep electron-updater's debug channel out of dsh-server.log

Status: implemented

English | [中文](2026-09-03-updater-log-hygiene.zh.md)

## Problem

The Windows client whose crash box produced [the multipart note](2026-09-03-updater-multipart-uncaught-exception.md) also sent in its `dsh-server.log`. One update, 0.1.0-rc.24 to 0.1.0-rc.28, had written around 700 lines into that file, and the update had succeeded.

Two sources produced them. electron-updater's `debug` channel carried the whole plan of the differential download — `DifferentialDownloader` writes `JSON.stringify(operations, null, 2)`, one `{ kind, start, end }` object per block, about 650 lines of it — followed by one line per checksum `downloadPlanBuilder` found repeated in the blockmap. And the differential download's own handled failure was recorded as `[updater] error: Cannot download differentially, fallback to full download: Error: net::ERR_CONNECTION_RESET` over a stack trace, because the shell passed that channel through verbatim.

Nothing in the block was wrong. The fallback is electron-updater doing what it is for, and the full download that followed installed the update. But `dsh-server.log` is the file support asks a user for, and what it held was 700 lines about a working update with the word `error` and a stack trace at the top of them — which is what the user pasted into a chat, as a crash.

## Decision

[`apps/desktop/src/updater-log.ts`](../../../../apps/desktop/src/updater-log.ts) owns what electron-updater is allowed to write. `updaterLogLine(channel, message)` renders one entry or returns `null`, and [`src/updater.ts`](../../../../apps/desktop/src/updater.ts) builds `built.logger` out of it — the whole decision is one pure function, and nothing about it needs electron to run.

The `debug` channel returns `null` but for two lines. What travels on it in 6.8.9 is three kinds of trace. A differential download's own: the plan dump `JSON.stringify(operations, null, 2)` (`DifferentialDownloader.js:41`), one `download range: bytes=a-b` per range issued (`DifferentialDownloader.js:184`), and one line per checksum found repeated in the blockmap (`downloadPlanBuilder.js:100`). `MacUpdater`'s Squirrel trace: the proxy's close, creation and listen lines (`MacUpdater.js:44`, `:47`, `:129`, `:131`, `:208`, `:210`) and the two probes that decide which artifact a Mac takes (`:59`, `:69`). And two lines that stand alone: `checkForUpdatesAndNotify called, downloadPromise is null` (`AppUpdater.js:290`), which this shell never produces because it does not call that method, and `updater cache dir: <path>` (`AppUpdater.js:552`). Nothing in the first two kinds names a version, a URL, a size or a failure, so none of it answers a question support asks, while together they bury the lines that do. What a differential download is worth knowing reaches `info` from the same two files and is kept: `File has <n> changed blocks` from `downloadPlanBuilder` and `Full: <size>, To download: <size> (<percent>%)` from `DifferentialDownloader`.

Two `debug` lines are kept, matched at the start of the message: `updater cache dir: <path>` and `nativeUpdater.update-downloaded` (`MacUpdater.js:24`). Both are written as `[updater] debug: <text>`, keeping the channel marker that `warn` and `error` already carry, so a line in the file still says which channel wrote it. Neither has an `info` or `warn` equivalent, and each answers a question the rest of the log leaves open. A differential download needs the previous artifact in that cache directory, so its path is what explains an update that transferred everything. The Squirrel line is the only record that the native updater finished staging a macOS update, and it accompanies the `squirrelDownloadedUpdate` flag that decides which branch `quitAndInstall()` takes (`MacUpdater.js:241`) — an install that proceeds at once, or one that waits for an event. `debug` is registered rather than left unset because upstream guards every call on it with `!= null`: an unset channel would drop those two as well, and it would leave the mapping with three channels in code and a fourth in an absent property.

`info`, `warn` and `error` are passed through under the prefixes they already had, with one rewrite. A message on `error` beginning `Cannot download differentially, fallback to full download: ` becomes

```
[updater] differential download unavailable (net::ERR_CONNECTION_RESET); this update transfers the whole artifact
```

— the first line of what follows the prefix, without its class name and capped at 320 characters, in the sentence form the shell's own lines already use (`[updater] in-place update unavailable (…); this run falls back to the download page`). The cap clears the longest first line upstream produces, the 217-character `sha512 checksum mismatch, expected …, got …` that `DigestTransform.validate` throws. The stack is dropped and the word `error` with it, because this is the one line on that channel that reports a failure the updater has already recovered from: `AppUpdater.differentialDownloadInstaller` logs it from a `catch` (`AppUpdater.js:705`, which macOS reaches through `MacUpdater.js:102` and Windows through `NsisUpdater.js:49`) and then completes the update by full download, and `NsisUpdater.js:170` and `AppImageUpdater.js:67` log the same text for the web-installer and AppImage paths. It is not the only line there that is not itself a failure — `closeFiles` reports `cannot close file "<path>": <e>` through `logger.error` on the success path (`DifferentialDownloader.js:66`) — but it is the one that carries a stack. Every other `error` message is written whole.

## Testing

[`apps/desktop/tests/updater-log.spec.ts`](../../../../apps/desktop/tests/updater-log.spec.ts) drives the mapping directly, on texts taken from 6.8.9 — its fixed strings verbatim, its templates filled in. On `debug`: the plan dump, a blockmap-duplicate line, a `download range:` line and a proxy line drop, while the two kept lines survive and a message that merely contains one of their texts does not, which is what pins the match to the start. On the other channels: the two `info` summaries and an ordinary `warn` keep their prefixes, and an `ENOENT` stack and a `status 503` message on `error` come through whole. Under the fallback prefix: a rendered stack becomes the single line above, the class name comes off the `version is different (…)` `Error` thrown at `DifferentialDownloader.js:36`, a reason that never carried one and a thrown value that is not an `Error` at all pass as written, an `HttpError` assembled the way `createHttpError` builds one (`builder-util-runtime/out/httpExecutor.js:52-57`) reduces to `503 Service Unavailable`, because its description block and header dump are on the lines the split already removed, the 217-character checksum mismatch passes with both digests intact, and a synthetic 400-character first line is capped. The `Full: …` and `File has … changed blocks` cases are what pins the claim that dropping `debug` costs no differential-download summary; the two `logger.info` call sites in `node_modules` are where that claim comes from.

## Alternatives considered

**Keep `debug` behind a setting.** A verbose switch is turned on after the failure it was needed for, never before, so the one log that would carry the extra lines is the one already sent. It would also add a settings surface for output that has answered no support question yet.

**Leave `debug` unset.** Every upstream call site guards on `logger.debug != null`, so an unset channel would drop the two lines this one keeps along with the rest. It would also put three channels in the mapping and decide the fourth by an absent property, which reads as an oversight rather than a decision.

**Drop the fallback line too.** It is the only record that a differential download was attempted and did not happen, and that is exactly what explains a full-size transfer on an update whose delta was small.

**Cap every long `error` message instead.** The other messages on that channel are failures still open when they are logged, and a failure support has to diagnose is wanted whole. The fallback is singled out because it is the one the updater has already recovered from by the time it reaches the log.

**Rewrite it in the `error` event listener in `src/updater.ts`.** The fallback never reaches that listener: it is caught inside electron-updater and only logged, so the shell sees it on the logger and nowhere else.

## Consequences

A support log for an in-place update now holds the check, the offer, the cache directory, the two `info` lines that size the differential download, the retries, the Squirrel staging record on macOS, and the install — and, where the differential path gave way, one line naming why. The trade is that a differential download that produces a wrong artifact leaves no block-level record in the file. What catches a wrong artifact is the sha512 `DigestTransform` at `DifferentialDownloader.js:121`, and the `ERR_CHECKSUM_MISMATCH` it throws (`builder-util-runtime/out/httpExecutor.js:431`) is raised inside `differentialDownloadInstaller`'s own `try` and lands in the same `AppUpdater.js:705` catch — so a checksum mismatch arrives on the rewritten line too, and the update then transfers the whole artifact. Keeping that message's two digests intact there is what the 320-character cap is for.

This closes the differential-fallback line and nothing else on `error`. `AppUpdater` registers its own `error` listener in its constructor and logs `Error: ${error.stack || error.message}` for every dispatched error (`AppUpdater.js:201-203`), and `downloadUpdate`'s `errorHandler` dispatches every failure that is not a `CancellationError` (`AppUpdater.js:449-460` → `:476-478`). So a `net::ERR_CONNECTION_RESET` that [`src/download-retry.ts`](../../../../apps/desktop/src/download-retry.ts) recovers from on the next attempt still leaves a stacked `[updater] error:` line from the logger, and the shell's own `error` listener in [`src/updater.ts`](../../../../apps/desktop/src/updater.ts) writes one more beside it. The differential fallback is not in that pair: it is only logged, never dispatched, which is why it can be rewritten at the logger and they cannot.

The rewrite is keyed on an upstream message that carries no code, so an electron-updater release that rewords it turns the rewrite off and passes the original line through — visible, not silent. The kept `info` summaries are keyed on nothing: they pass through whatever text those two call sites hold.
