# Agent Note: Log main-process crashes, and reject on a multipart range error

Status: implemented

English | [中文](2026-09-03-updater-multipart-uncaught-exception.zh.md)

## Problem

A Windows client updating in place showed Electron's own 「A JavaScript error occurred in the main process」 box carrying `Uncaught Exception: Error: net::ERR_CONNECTION_RESET` while an update was downloading, and `dsh-server.log` — the file a user is asked to send — recorded only electron-updater's `Cannot download differentially, fallback to full download` line. The update finished by full download; nothing in the file said a crash box had been on screen at all.

Two independent defects met there. electron-updater 6.8.9's `out/differentialDownloader/multipleRangeDownloader.js` attaches `response.on("error", reject)` in its single-range branch and in `DifferentialDownloader`, but not in the multipart branch that a plan of more than one byte range takes; an interrupted multipart response therefore raises an `error` event with no listener, which Node throws from the emitter. And Electron's default handler in `lib/browser/init.ts` shows that box and writes nothing, standing aside as soon as the application registers a handler of its own — this shell registered none, so every main-process exception was visible once and recorded nowhere.

## Decision

`patches/electron-updater@6.8.9.patch` carries electron-builder commit `5eed26b2a9cfd06a1dbe207b25a46ce2c0b05ae9` (PR #10021) verbatim: one `response.on("error", reject);` as the first statement of the multipart branch's response callback. `pnpm-workspace.yaml` records it under `patchedDependencies`, beside the retirement condition — the first electron-updater release carrying that commit, which 6.8.9 predates as the latest published version.

[`apps/desktop/src/crash-log.ts`](../../../../apps/desktop/src/crash-log.ts) registers the shell's `uncaughtException` and `unhandledRejection` handlers on the log sink `main.ts` opens, immediately after that sink exists and before the updater and the server start. An exception writes `[desktop] uncaught exception: ` and the rendered value as one entry, then opens the box Electron would have opened: the same title, and `Uncaught Exception:` over the same body. That body is identical to Electron's for an `Error` — its stack, or the `name: message` line when it carries none. A thrown value that is not an `Error` is rendered as `String(value)`, which Electron does not do: it reads `name` and `message` off the value and composes `undefined: undefined`, or throws while composing when the value is `undefined` or `null`. Nothing on the reporting path touches `Error` properties, because a handler that throws while reporting is a process Node ends with no record at all. A rejection writes `[desktop] unhandled rejection: …` and opens nothing, because Electron shows no box for rejections either. Neither handler exits: Electron's default does not, and an exception raised on a background stream must not end a session.

The launch chain does not reach either handler. `main.ts` runs its startup inside `app.whenReady().then(…)`, so a throw above its own `try` — the boot window, the log directory, the tray — becomes a rejection of that promise, and Electron 43 runs a main-process rejection in `warn-with-error-code` mode: unreported, such a launch stops with an empty boot page and nothing anywhere. The chain therefore ends in `.catch`, which reports through the exported `reportUncaughtException`. The log sink it reports to is read at report time, and before the file exists that sink writes to stderr rather than dropping the line, so no point in the launch is silent.

The two halves are independent. The patch keeps this one failure out of the box; the handlers make every other main-process exception — including one the patch does not cover — reconstructable from the log.

## Testing

[`apps/desktop/tests/electron-updater-multipart.spec.ts`](../../../../apps/desktop/tests/electron-updater-multipart.spec.ts) loads the module from `node_modules`, so it checks the code the packaged app runs rather than a copy of it. It drives two `DOWNLOAD` tasks through `executeTasksUsingMultipleRangeRequests` with a fake HTTP executor and a `PassThrough` response, emits `error` on that response, and requires the emit not to throw and the reject callback to have received it. Against the unpatched 6.8.9 the emit throws with nothing rejected, which is the field failure. The suite is the safety net and not the retirement signal, because it stays green whether the line comes from the patch or from a later release; pnpm is the signal, since neither `allowUnusedPatches` nor `ignorePatchFailures` is set and a bump that leaves this exact-version patch unused or unapplicable fails the install.

That signal is the root install's, and only the root install's. pnpm applies `patchedDependencies` to a filtered `pnpm deploy` as it does to an install, so a deploy whose closure lacks a patched package ends in `ERR_PNPM_UNUSED_PATCH` before staging anything — and no closure this repository deploys contains electron-updater, which belongs to the Electron shell packaged from `apps/desktop`'s own `node_modules`. Every such deploy therefore carries `--config.allow-unused-patches=true`: the desktop client's embedded server closure and the Python runtime's executable closure today, and any future one on the same terms. [`scripts/filtered-deploy.ts`](../../../../scripts/filtered-deploy.ts) owns that command line for both, and [`scripts/filtered-deploy.spec.ts`](../../../../scripts/filtered-deploy.spec.ts) holds the flag and the linker settings in place.

The flag is one boolean for the whole deploy, not a per-patch exemption: it masks every patch that deploy leaves unused, so nothing about retirement can be read from a deploy. A patch whose package IS in the closure still applies and still fails the deploy when it cannot — node-pty is in both closures on that footing — but pnpm no longer says so when one stops arriving, so `verifyStagedPatches` reads the staged tree for the text each patch adds and fails the build when the published package is standing in its place. A closure that stops containing one of those packages fails that check too, and deliberately: `STAGED_PATCHES` is where a closure legitimately losing a patched package is recorded.

[`apps/desktop/tests/crash-log.spec.ts`](../../../../apps/desktop/tests/crash-log.spec.ts) registers against a recording sink and error box, identifies the two handlers as the listeners `process` did not carry before, and invokes them directly — with an `Error`, with an `Error` carrying no stack, and with the thrown string and thrown `undefined` that a handler reading `.message` would die on. `reportUncaughtException` is covered on its own, since the launch chain reaches it without any registration. Every registration goes through the shared disposer `afterEach` runs, so a failing assertion cannot leave the runner holding a listener of this suite's.

## Alternatives considered

**Wait for an electron-updater release.** The fix landed upstream on 2026-07-18 and no release carries it; 6.8.9 remains the latest. Waiting leaves every multipart differential download one dropped connection away from a crash box, on a channel whose whole purpose is unattended updates.

**Fork or vendor electron-updater.** A one-line divergence does not justify owning the package's release cadence, and a pnpm patch retires by deletion the moment upstream ships, while a vendored copy has to be re-synced to notice.

**Handle it in [`src/updater.ts`](../../../../apps/desktop/src/updater.ts) instead.** The event is thrown by the emitter inside electron-updater's own callback; nothing the shell subscribes to sees it, and the updater's fallback already ran — the full download it fell back to is what finished. The shell has no seam here.

**Let the registered `unhandledRejection` handler cover the launch chain.** It fires only once the handlers are registered, which is after the boot window and the log directory — the two steps most likely to fail — and it writes a line without opening a box, so a launch that stops dead would say so only in a file nobody has been told to open yet. The explicit `.catch` covers the whole chain and reports it as what it is.

**Exit the process after logging an uncaught exception.** That would change the visible behavior this fix deliberately preserves: the reported crash cost the user a box, not the session, and killing the shell on a background stream error would turn a recoverable download failure into a lost session.

**Write the crash to a file of its own.** A second file is a second thing to ask a user for. `dsh-server.log` is already the file the menu opens and support asks for, and the entry lands in the same timeline as the updater lines that precede it.

## Consequences

A multipart differential download interrupted mid-transfer rejects into electron-updater's existing fallback, which is the path that recovered the reported case; the difference the user sees is the absent box. The desktop's dependency closure carries a patched electron-updater, so `pnpm-lock.yaml` pins it by patch hash and a bump to any later 6.8.x re-applies or retires the patch explicitly rather than silently dropping it.

`dsh-server.log` holds every main-process exception and rejection, and every failure of the launch chain. No point in that chain is silent: before the log file is open the report still opens the box, and its line goes to stderr. What stays outside is a throw at a module's top level, above `whenReady` — there is no sink and no `catch` there, and Electron's own handler owns it. The registration costs two process listeners and no work until something throws.
