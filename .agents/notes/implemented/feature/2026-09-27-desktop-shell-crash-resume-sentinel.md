# Agent Note: Desktop shell: the intentional-stop sentinel for crash resume

Status: implemented

English | [中文](2026-09-27-desktop-shell-crash-resume-sentinel.zh.md)

## Problem

The `@haoran/dsh-crash-resume` server plugin continues a turn that a server crash interrupted and holds a turn that a stop request interrupted. After either, the session log ends inside an open turn, so the plugin decides by the file `$DSH_HOME/crash-resume/intentional-stop.json`: present at the next start means a stop, absent means a crash. The plugin writes that file itself on SIGTERM. On Windows the shell stops the server with `taskkill /pid <pid> /T /F` (`killTree` in `apps/desktop-shell/src/server.ts`), which runs no server code, so without a writer in the shell every Windows quit and update restart would read as a crash and continue the interrupted turn.

## Decision

`src/crash-resume-sentinel.ts` exports `writeIntentionalStop(home, reason, log)`. It writes `{"version":1,"at":<epoch ms>,"by":"shell","reason":"quit"|"update"}` and a newline, the fields in the order of the plugin's `formatSentinel` (`packages/crash-resume/src/state-files.ts` in the plugin repository), through the plugin's `writeAtomicSync` steps: `mkdirSync` recursive, a temporary `intentional-stop.json.<pid>.<ms>.tmp` in the same directory, `writeSync` + `fsyncSync`, `renameSync` over the sentinel (removing the temporary file when the rename fails), and a directory fsync except on Windows. The API is synchronous so the file is on disk before the stop is sent. Any failure is logged as `[desktop] crash-resume sentinel: <message>` and swallowed.

The home is `resolveHarnessHome()` on the shell's `process.env`, which is what `startEmbeddedServer` hands the quarantine scan; the server child's environment is `augmentedEnv(process.env)` plus launch additions that never include `DSH_HOME`, so the server and the plugin's default `stateDir` resolve the same directory.

Two call sites write it, both through `src/server-lifecycle.ts` hooks so the order is tested with fakes: `stopForQuit` calls `markIntentional` before the cookie removal and the stop (reason `quit`; this covers `before-quit` and the update installer's `prepareQuit`), and `stopForMandatoryUpdate` calls it before the stop a mandatory update forces at launch (reason `update`). Nothing else writes it: `respondToCrash` has no such hook, `relaunchForRecovery` raises `quitting` before `app.quit()` so `before-quit` returns without a stop, and `server.ts` — the startup-timeout kill and `sweepOrphanedServers` — does not import the module. `tests/server-lifecycle.spec.ts` asserts the two call sites and the count of calls in `main.ts`.

On macOS and Linux the plugin writes the file on SIGTERM and the shell writes it before sending SIGTERM. Both writers rename a complete file of their own over the target, their temporary names differ by pid, and the plugin reads only `version`, so the second write replaces a valid sentinel with another valid one.

## Alternatives considered

**Letting only the plugin write the sentinel.** That covers POSIX only; Windows is the reason the shell writes at all.

**Having the shell write only on Windows.** One code path on every platform keeps the ordering tests meaningful on the development machines, and the extra write on macOS costs one small file operation per quit.

**Writing asynchronously.** The quit handler would have to await the write before `taskkill`; a synchronous write keeps the stop sequence unchanged and bounds the delay to local file operations.

## Consequences

A Windows quit or update restart no longer continues the turn it interrupted; the plugin holds it for the user. A failed write costs at most one continued turn at the next start and never delays the quit beyond the file operations. Without the plugin installed the file stays in the home, one line long, unread. After an update install that fails and restarts the server, the plugin reads the sentinel of the stop before the install and holds the turns that stop interrupted. A crash of the shell itself leaves an orphaned server with no sentinel, and the next launch's orphan sweep kills it, so its turns are continued as after a crash.
