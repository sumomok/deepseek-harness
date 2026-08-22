# Agent Note: An interrupted update download is retried, not surrendered

Status: implemented

English | [中文](2026-08-21-desktop-update-download-retry.zh.md)

## Problem

A single dropped connection during an update download ends the update for the whole session, and on macOS it also ends the tier that download was running on.

electron-updater retries nothing and resumes nothing. The full download sends no `Range` header, and every error out of `AppUpdater.executeDownload` calls `removeFileIfAny`, which unlinks the partial file and — through `DownloadedUpdateHelper.clear` — empties the pending directory. The differential path is no help: it fetches the artifact block by block over `Range` requests, one failed block rejects the whole round, and `differentialDownloadInstaller` catches that and returns true so the same call degrades to a full download; it also runs only when `<cacheDir>/update.zip` is already there, which is never true for the first update after an install. There is no timeout or retry option to set, and `httpExecutor` is not a documented extension point.

What that costs is decided in the shell, and [the update channel](../feature/2026-08-19-macos-in-app-update-self-signed.md) answered every failure with the same action. The `error` listener in `apps/desktop/src/updater.ts` closed the progress window, cleared the taskbar progress, and on darwin called `demoteMac` for any error at all. The same failure then rejected `downloadUpdate()`, reached `runCheck`'s inner catch, demoted again, and re-ran the check on the download-page tier in the same tick. The visible result of one interrupted transfer, on a startup or manual check, was a 「去下载」 dialog offering a browser download of a build the app is able to install itself, plus `macInstallUnavailable` set for the rest of the run, so every later check that session handed off to the browser too. On Windows nothing demotes, but the pending directory is emptied the same way and the check ends with nothing said.

The two failures a download can end in are not alike, and the channel treated them alike: a cut connection says nothing about whether this build can replace itself, while a signature refusal or a checksum mismatch says exactly that.

## Decision

An interrupted download is attempted again — three more times, at 2 s, 6 s and 18 s — before any surface reports it, and only a failure that installing again cannot fix takes macOS off the in-place tier.

### The policy is a module with no electron in it

`apps/desktop/src/download-retry.ts` holds the whole decision: `classifyDownloadError`, `describeDownloadError`, `RETRY_DELAYS_MS`, and `withRetry(run, delays, { onRetry, sleep })`, whose `sleep` is injected so the plan is exercised against an instant clock. `updater.ts` and `progress-window.ts` import electron and are not unit-testable; nothing in the policy needed to be there.

`withRetry` calls `run` once per attempt — each attempt is a whole download, since nothing of the previous one survives — and rejects with the error the last attempt failed with, both when a failure is fatal and when the plan runs out. The caller classifies that error again to decide what its own surface does.

### What is retried

The classifier is fail-closed: a failure is transient only when it matches a known network condition, and everything else, including a value that is not an `Error`, is fatal. An unrecognized failure therefore ends the download instead of re-transferring a few hundred megabytes three more times on a guess.

| Verdict | Failures |
|---|---|
| `transient` | `ECONNABORTED`, `ECONNREFUSED`, `ECONNRESET`, `EAI_AGAIN`, `EHOSTUNREACH`, `ENETDOWN`, `ENETRESET`, `ENETUNREACH`, `ENOTFOUND`, `EPIPE`, `ESOCKETTIMEDOUT`, `ETIMEDOUT`; any message naming a `net::ERR_…` reason, which is how Electron's `net` module reports every failure and is the executor the download runs on; `Request timed out` and `Request has been aborted by the server` from `HttpExecutor`; Node's `socket hang up`; a 5xx, 408, 425 or 429, whether it arrives as an `HttpError` code or in `doDownload`'s `Cannot download "<url>", status <n>` text |
| `fatal` | any `ERR_UPDATER_*` code, `ERR_UPDATER_INVALID_SIGNATURE` among them; `ERR_CHECKSUM_MISMATCH` from `DigestTransform`; any other 4xx; `Too many redirects`; a full disk; everything unrecognized |

`ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` wraps a network fault at check time and is classified fatal, which is correct here because the classifier answers for the failures of `downloadUpdate` only — a failed `checkForUpdates` has the tier fallback of its own. That last clause was wrong about what the fallback costs, and [the check-retry note](2026-08-22-desktop-update-check-retry.md) supersedes it: the check path's fallback demoted macOS for the rest of the run, so checks now run through this same classifier behind a retry plan of their own.

### One place starts a download, one place decides what a failure means

`updater.ts` has three download entry points — the offer a user accepted, the mid-session mandatory download, and the mandatory launch block — and all three now go through `download(host, version, run)`. It owns `downloading`, the progress window and the taskbar progress for the whole transfer including the retries, so the three entries differ only in what they log and what they do with the answer:

- **completed** — `update-downloaded` takes over, unchanged.
- **transient, plan exhausted** — returns false. Nothing demotes, the tier does not change, and the next scheduled check starts the transfer over. A manual check gets one dialog saying the download did not get through; a silent check gets a log line.
- **fatal** — demotes macOS and rethrows, which drops the check to the download-page tier through `runCheck`'s existing catch. That is the behavior the channel always had for this class of failure.

`ERR_UPDATER_INVALID_SIGNATURE` is fatal on both platforms, so a Windows installer signed by someone else is never re-downloaded on the chance that it comes back different.

The `error` listener stands down while `downloading` is true. That failure is delivered twice — to the listener and to whoever awaited `downloadUpdate()` — and `download` is the half that can tell what it means; acting on it in the listener would close the window the retry is about to write to and demote the tier for a dropped packet. With `downloading` false the listener does what it always did, which is where a failure inside Squirrel surfaces: staging and installing run after every promise this module awaits has settled.

`blockWithInstaller` keeps its 「重试」/「退出应用」 dialog, and it appears after the automatic retries rather than instead of them — the button is for a fault that outlasted 26 seconds of trying, and pressing it re-enters the whole plan.

### What the window says

`progress-window.ts` gains one status line under the bar and `showRetrying(attempt, total, delayMs)`, which writes 「下载中断,N 秒后重试(n/N)…」 into it. The window stays open across a retry: the transfer restarts from zero, so closing and reopening it would be the only thing on screen that looked like progress. The next `download-progress` sample clears the line, so a resumed download needs no separate call to take the notice down, and the line is remembered like the last sample is, so a window the user closed and a manual check reopened comes back saying the same thing.

## Alternatives considered

**A resumable downloader owned by the shell.** The only design that makes a retry cheap rather than merely bounded: fetch the artifact with our own `Range` requests, keep the partial file, and hand electron-updater a finished download. It is the right answer for a client on a bad connection, and it is not this change, because it has to reproduce the private layout electron-updater validates before it will install anything — the `pending/` directory, `update-info.json`, the base64 sha512 the manifest publishes — none of which is a documented contract, and all of which a minor version may change under us. The condition for building it is evidence: if this plan still leaves a measurable share of downloads failing once it is in the field, the failure rate is the argument for owning the transfer.

**Subclassing `MacUpdater` or replacing `httpExecutor`.** The retry would sit where the transfer is, which is the natural place for it. `httpExecutor` is not an extension point — it is assigned in the constructor and typed as internal — and the method that would have to be overridden on macOS, `updateDownloaded`, is private and reaches into the local proxy server the class also owns. A subclass would be pinned to one patch version of a library this product does not control.

**Retrying until it succeeds, with a growing delay.** A download that keeps failing is usually a feed or a machine that is not going to start working in the next few minutes, and an unbounded plan holds the mandatory launch block — which downloads before the app opens — for as long as the failure lasts. Three attempts over 26 seconds cover a Wi-Fi handover, a route change and an nginx reload; past that, the next scheduled check is a better retry than a fourth attempt, because it costs the user nothing to wait for.

**Jitter on the delays.** Standard against a thundering herd, and there is no herd: the feed is a static nginx directory whose clients check on their own launch times and four-hour timers, so their retries are already spread. Fixed delays keep the plan reproducible in the log and in tests.

**Classifying an unknown failure as transient.** More downloads would eventually succeed, and every unrecognized fatal error would cost three more full transfers and 26 seconds before reporting the same thing. Fail-closed also keeps the classifier honest: a failure worth retrying gets a row in the table and a test, rather than arriving by default.

## Consequences

A download interrupted by the network costs seconds instead of the session's update channel, and macOS keeps the in-place tier through it. A build that cannot be installed demotes on the first attempt, so the download-page fallback still arrives without a wait.

The cost is wall clock on a genuinely dead connection: a mandatory launch block now spends up to 26 seconds plus four transfer attempts before it offers 「重试」/「退出应用」, and an ordinary check spends the same before it goes quiet. Each attempt re-transfers the whole artifact, so a connection that fails late in a large download pays that in bandwidth three more times. Nothing here makes an update resumable, and the first update after a fresh install is a full download whatever happens, because the differential path needs a previous `update.zip` in the cache directory.

`apps/desktop/tests/download-retry.spec.ts` pins the classification of every row in the table above, the unknown-is-fatal default, the delay sequence and the `onRetry` reports against an injected clock, that an exhausted plan rejects with the last failure, and that a fatal failure is not retried or waited on. `updater.ts` and `progress-window.ts` import electron and stay unit-untested; what they carry is the wiring the module test cannot see, and the update channel has no snapshot lane — it runs in a packaged Electron shell against a live feed, so its evidence is a signed build and a real interrupted download.
