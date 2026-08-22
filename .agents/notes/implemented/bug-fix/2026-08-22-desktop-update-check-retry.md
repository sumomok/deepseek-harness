# Agent Note: A check the network interrupted is retried, and stops costing the in-place tier

Status: implemented

English | [中文](2026-08-22-desktop-update-check-retry.zh.md)

## Problem

[The download-retry note](2026-08-21-desktop-update-download-retry.md) scoped its classifier to `downloadUpdate` and said so: "a failed `checkForUpdates` has the tier fallback of its own". That fallback is `runCheck` demoting macOS and answering from `checkGeneric` instead — and `demoteMac` sets `macInstallUnavailable`, which is not per-check. It is the rest of the run. So the tier cost the download path had just been taught to avoid was still being paid in full by any check that met a dropped connection, and the fallback the note called sufficient was the same permanent demotion described one paragraph earlier as the bug.

rc.17 made it reproducible. The shell gained two pieces of synchronous main-process work between the first check going out and the server-ready check that follows it — seeding the desktop profile, and opening the render service — and on a first launch the delay was enough for the first check's connection to sit idle until the far end closed it. The log reads `Checking for update (already in progress)`, then `net::ERR_EMPTY_RESPONSE`, then `in-place update unavailable … falls back to the download page`. rc.16's launch log carries neither line. The feed was ruled out by hand: five serial and three concurrent requests, all 200 in about 0.1 s.

Three call sites demoted for any check failure at all — `resolveGate`'s catch, `runCheck`'s catch around `checkInPlace`, and the `error` listener — so the same failure could arrive at more than one of them and `demoteMac`'s once-guard decided only which one got to log it.

## Decision

A check is retried on a transient failure, and only a failure that retrying cannot fix takes macOS off the in-place tier.

### The retry runner is shared; the plan is not

`downloadWithRetry(run, hooks)` becomes `withRetry(run, delays, hooks)`, generic in what the attempt returns so a check can hand its manifest back through it. `RETRY_DELAYS_MS` stays the download plan. `CHECK_RETRY_DELAYS_MS` is `[1_000, 3_000]`: a check transfers one small manifest, so an interruption costs a request rather than a few hundred megabytes, and the whole plan fits inside the fifteen seconds `GATE_TIMEOUT_MS` allows — which is what lets a mandatory launch gate that meets a dropped connection reach its verdict from a retry instead of from its own timeout.

The classifier is unchanged and stays shared. That is deliberate but it has an edge worth naming: `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` wraps a check-time network fault and remains `fatal`, so a check failing that way is still neither retried nor survivable by the tier. The regression above surfaced as `net::ERR_EMPTY_RESPONSE`, which is transient, and is covered. Widening the classifier for check time was rejected below.

### One place asks the feed, and holds the check open while it retries

`checkFeedWithRetry(host, instance)` wraps `checkForUpdates()` for both callers that had one — `checkInPlace` and `resolveGate` — and holds `checkInFlight` for the whole plan.

That flag is the half that makes the retry work at all. Every failed attempt raises the `error` event, and the listener demoted unconditionally; without the flag, attempt one would take the tier away before attempt two could succeed and the retry would be decoration. The listener now stands down for a check exactly as it already stood down for a download, and for the same stated reason: the caller mid-plan is the half that can tell what the failure means. What still reaches the listener is what always did — a failure inside Squirrel, which runs after every promise this module awaits has settled.

### Demoting is classified at both remaining sites

`resolveGate` and `runCheck` demote only for `fatal`. A transient failure that outlived the retries costs that one check — `resolveGate` still reads the raw manifest below it, `runCheck` still answers from `checkGeneric` — and the next check tries in place again. That is the same rule the download path already followed, now stated in the two places that had been left out.

## Alternatives considered

**Classifying only, without retrying.** One line at each of three sites, and it fixes the reported symptom: a transient check failure stops costing the run's tier. It was rejected because the check still falls to the download page for that round, which is a browser download of a build the app can install itself — the exact surface the download-retry note set out to stop offering. Retrying first is what makes the fallback rare rather than merely recoverable.

**Reusing `RETRY_DELAYS_MS` for checks.** One plan, one constant, nothing new to justify. Its 26 seconds outlast `GATE_TIMEOUT_MS`, so a mandatory launch gate would answer from its own timeout while the retries were still running — the gate would open on a machine that is below the red line, and the retry's whole point at that call site would be lost.

**Widening the classifier at check time**, so `ERR_UPDATER_CHANNEL_FILE_NOT_FOUND` is transient when a check raises it. A missing channel file is cheap to re-request, unlike a re-transferred artifact. Rejected for now because that code covers a feed that genuinely has no manifest for this channel as well as a network fault, and telling them apart needs the cause the wrapper does not carry. It stays fail-closed until a real feed produces the transient form.

**Retrying inside the `error` listener.** The failure arrives there first, so the retry would start sooner. The listener has no way to return an answer to whoever awaited `checkForUpdates()`, so the caller would still see the original rejection and act on it while a retry ran behind it.

## Consequences

A first launch that meets a dropped connection retries the check twice within four seconds and keeps in-place updates for the run. A check that fails past the retries costs that round only, and the next scheduled, manual, or server-ready check tries in place again. A build that genuinely cannot install itself still demotes on the first attempt, with no wait added.

The cost is up to four seconds of waiting plus three request attempts before a check gives up, and the mandatory launch gate spends that inside its existing fifteen-second race rather than beyond it.

`apps/desktop/tests/download-retry.spec.ts` covers the generic runner, the value it hands back, that the check plan is what spaces a retried check, and the two invariants that keep the check plan tighter than the download plan and inside the gate's budget. `checkInFlight`, `checkFeedWithRetry`, and the two classified demotions live in `updater.ts`, which imports electron and stays unit-untested for the reason the download-retry note gives; their evidence is the same as that note's — a signed build against a live feed, and the launch log that first showed the demotion.
