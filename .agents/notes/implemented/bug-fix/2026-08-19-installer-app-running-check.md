# Agent Note: The installer's app-running check matched every process

Status: implemented

English | [中文](2026-08-19-installer-app-running-check.zh.md)

## Problem

A Windows update of the [desktop client](../feature/2026-08-18-desktop-update-channel.md) stopped at 「DSH Desktop 无法关闭。请手动关闭它,然后单击重试以继续」 — NSIS's `appCannotBeClosed` — whose Retry button re-enters the loop that produced it, so the install has no way forward and no way out but Cancel.

Three observations from the machine narrow it to one thing. An administrator PowerShell taken at the moment of the failure found **no process at all** under the install directory `D:\soft\DSH Desktop`, and exactly one process matching `*DSH*` on the whole machine: the installer itself, running from `%LOCALAPPDATA%\@deepseek-aidsh-desktop-updater\pending\`. It reproduced on a hand-started right-click-**Run as administrator** install, which has no `elevate.exe` at any point. And the message is `appCannotBeClosed`, which the template only reaches after its own check has decided the app is running and then failed to stop it.

So the installer was not looking at a stuck process. It was looking at the wrong set of processes.

## Decision

`build/installer.nsh` defines `customCheckAppRunning`, which `CHECK_APP_RUNNING` (`include/allowOnlyOneInstallerInstance.nsh:32-43`) substitutes for the whole built-in step. That is the only useful granularity: the pieces underneath — `FIND_PROCESS`, `KILL_PROCESS`, `_CHECK_APP_RUNNING` — are each wrong in ways a wrapper cannot repair.

The replacement does what the built-in step was meant to do. `elevate.exe` is stopped first, alone and **without** `/T`: this installer is its child, so a tree kill would end the install, and stopping it first also detaches this process from the app's descendants before anything else is killed with `/T`. Then the app and its `node.exe` server get 10 s to leave on their own and what remains is tree-killed, because the server's own children — shells, language servers — hold the same files it does. It runs in one PowerShell process rather than one per poll: the query costs more than the 500 ms between polls, so a poll count is not a time budget.

Three rules bound it, and they are the actual repair:

1. **`$INSTDIR` is not trusted.** It is used as a path prefix only when it is an absolute drive path, longer than a volume root, whose directory exists and holds `${APP_EXECUTABLE_FILENAME}` — and then only with a separator appended, so a sibling directory sharing a name prefix cannot match. Anything else drops to exact image names.
2. **This process is never a match.** Its pid, from `kernel32::GetCurrentProcessId`, is excluded from every match set; the two image names it matches by are neither the installer's (`… Setup <version>.exe`) nor the uninstaller's (`Uninstall ….exe`).
3. **Kills are bounded from above, never "kill what matched".** A process qualifies by exact image name always, and by path prefix additionally when there is a verified one. The degraded path therefore reaches `elevate.exe` — found by walking this process's own ancestor chain, which can only contain the launcher that started us — and the app, tree-killed; never a bare `node.exe`, which on any machine belongs to someone else.

**One hook, not two.** The previous `customInit` is gone rather than kept beside this. `.onInit` runs before the directory page has settled `$INSTDIR`, so a sweep there matches against a value that is still provisional — exactly the input class that produced this bug — while `customCheckAppRunning` runs at the two points that matter and nowhere else: in the install section before `uninstallOldVersion`, silent or not (`installSection.nsh:35-37`), and in the uninstaller before it starts moving files, from either its silent `un.onInit` path or its section (`uninstaller.nsh:19,150`). Both compilations receive `build/installer.nsh`, because the uninstaller is the same `installer.nsi` built with `-DBUILD_UNINSTALLER`, so the uninstaller side needs no second definition — and everything in the file is legal inside an `un.` function: no `Call`, no function definitions, plugin calls and inline LogicLib only.

## Where `$INSTDIR` comes from, and what an unresolved one costs

`initMultiUser` → `setInstallModePerAllUsers` (`multiUser.nsh:62-99`) reads `InstallLocation` from `HKLM\SOFTWARE\<APP_GUID>` — `Software\${APP_GUID}`, where the GUID is `UUID.v5(appId, …)` = `e36966b0-1805-5ec4-9648-404e09da7db1` for `dev.dsh.desktop` — and falls back to `%ProgramFiles%\DSH Desktop` when the value is absent. `registryAddInstallInfo` (`include/installer.nsh:103-106`) is the only writer, and it writes to that key alone: **the `Uninstall` entry beside it carries `DisplayName` and `UninstallString` and never an `InstallLocation`**, so an empty one there is by design and is not evidence of anything.

A missing value costs more than the message this note is about. `uninstallOldVersion` recovers the right directory for the *old* uninstaller — from `InstallLocation` when set, otherwise from the parent of its `UninstallString` — and passes it as `_?=`. The uninstaller's `un.onInit` then reaches `initMultiUser` (`uninstaller.nsh:31`), which re-reads the same empty key and **overwrites `$INSTDIR`** with the `%ProgramFiles%` fallback before the uninstall section runs. The old version is therefore not removed while the new one extracts into the fallback directory: the app relocates, silently, and the old copy stays on disk.

## Two upstream defects

Both are in app-builder-lib 26.15.3's NSIS templates and are worth reporting upstream; neither is filed.

**`FIND_PROCESS` ignores its `_FILE` parameter and prefix-matches `$INSTDIR`** (`include/allowOnlyOneInstallerInstance.nsh:64-79`). Its PowerShell branch (`:66`) is `Get-CimInstance Win32_Process | ? {$_.Path -and $_.Path.StartsWith('$INSTDIR','CurrentCultureIgnoreCase')}` with a `.Count -gt 0` test, so the file name every caller passes is discarded and any process under the install directory answers for the app. The prefix carries no trailing separator, so `C:\Program Files\App` also matches `C:\Program Files\App Server\…`. And `String.StartsWith("")` is true of every string, so an `$INSTDIR` that did not resolve matches the entire machine — at which point `KILL_PROCESS` (`:81-103`) walks that same set with `Stop-Process -Force`, most of which fails on processes the installer has no business touching, `_CHECK_APP_RUNNING` (`:105-166`) finds survivors on its second pass (`$R1 > 1`), and the run dead-ends in `appCannotBeClosed` with a Retry that repeats it. Minimal reproduction: an assisted `perMachine` NSIS build whose `$INSTDIR` fails to resolve (clear `HKLM\SOFTWARE\<guid>\InstallLocation`, or pass an `/D=` that resolves to a volume root), started while any unrelated process is running.

**The uninstaller discards its `_?=` directory.** `un.onInit` (`uninstaller.nsh:31`) inserts `initMultiUser` after NSIS has already set `$INSTDIR` from `_?=`, and `setInstallModePerAllUsers` assigns `$INSTDIR` unconditionally from the registry or its default. An installer's `uninstallOldVersion` (`include/installUtil.nsh:169-176`) goes to the trouble of deriving the correct directory and hands it over as `_?=`, and the uninstaller then throws it away. Minimal reproduction: install per-machine, delete `HKLM\SOFTWARE\<guid>`, run a newer installer, and observe that the old directory survives while the new one lands in `%ProgramFiles%`.

The exact `$INSTDIR` the failing run held is not recoverable from the machine after the fact. The empty string is the value most consistent with what was seen — it is the only one that matches a process outside the install directory *and* explains why the previous `customInit` sweep was inert, since its `('$INSTDIR').TrimEnd('\')+'\'` becomes `\`, which no absolute path starts with, so it swept nothing and exited successfully — but a prefix that is merely too broad (a volume root, or a parent directory) fits the same observations. The first rule above rejects the whole class, which is why the repair does not depend on settling it. One tempting explanation is ruled out: this NSIS is built with `NSIS_MAX_STRLEN=8192` (verified against the `x86-unicode` stub electron-builder ships), so the ~1040-character sweep command was never truncated.

## Verification

A hook that is not compiled in fails silently — `!ifmacrodef` simply does not fire — so `customCheckAppRunning` is proved by injecting `!error` into its body and reading the compiler's reply:

```
Command line defined: "BUILD_UNINSTALLER"
!error: DSH-HOOK-COMPILED-IN
Error in macro customCheckAppRunning on macroline 1
Error in macro CHECK_APP_RUNNING on macroline 6
!include: error in script: "uninstaller.nsh" on line 2
```

That is the whole claim in five lines: the hook is reached, `CHECK_APP_RUNNING` is what reaches it, and the compilation reporting it is the **uninstaller's** — `uninstaller.nsh:2` is `un.checkAppRunning`'s only statement — so the uninstaller side is covered by this one definition. Repeat it whenever `build/installer.nsh` is renamed, moved, or newly ignored.

The generated command is checked for the two things that silently break an `nsExec` one-liner: it carries no double quote (the whole PowerShell body is single-quoted, so nothing terminates the `-Command` argument early), and it expands to about 1220 characters against a 8192-character limit.

Everything past the compiler needs real Windows. `pnpm run test:snapshot` does not reach NSIS, and the macOS host has no PowerShell to parse the sweep body against.

## Alternatives considered

**Keep `customInit` and add `customCheckAppRunning` beside it.** Rejected because the two would run the same sweep seconds apart against two different `$INSTDIR` values, and the earlier one is the less trustworthy: `.onInit` precedes the directory page. Duplicating the logic to hedge on which value is right is how the two drift apart.

**Wrap the built-in check instead of replacing it — sweep first, then let `_CHECK_APP_RUNNING` confirm.** Rejected because the confirmation is the defect. A machine whose `$INSTDIR` does not resolve fails the built-in check no matter how clean the directory is, and there is no hook between `CHECK_APP_RUNNING` and its internals to correct it.

**Patch the vendored template.** Rejected: app-builder-lib is an npm dependency, not vendored source, and a patched `node_modules` is invisible to every other checkout and to CI. `customCheckAppRunning` is the extension point upstream provides for exactly this.

**Drop `packElevateHelper` so no `elevate.exe` exists to be misjudged.** Rejected because it does not fix the misjudgment — the failure reproduces with no `elevate.exe` anywhere — and it costs the elevation the per-machine uninstall genuinely needs: `isAdminRightsRequired` is emitted only when that option is set, and `CreateProcess` cannot elevate an installer whose manifest requires administrator.

**Write `InstallLocation` from the app at launch, so the key repairs itself.** Rejected as the wrong owner. The installer writes that value in its own install section, and an app writing to `HKLM` needs elevation it otherwise never asks for; a check that cannot be trusted with a bad value is the thing to fix.

## Consequences

The installer no longer asks the user to close an application: it waits 10 s and then stops what it can prove is this product's. A manual install started while the app is open therefore takes the app down without the built-in step's confirmation dialog, which is the deliberate cost of never showing a dialog the user cannot satisfy.

An install directory the sweep cannot verify degrades to image names rather than failing, so the app and the update's launcher are still cleared and only the bundled `node.exe` server is left to whatever the old uninstaller can manage. That is a real gap on exactly the machines that produced this bug, and the readable signal for it is one `DetailPrint` line.

The uninstaller inherits the same check from the same file, so a manual uninstall of a build carrying this fix cannot dead-end the way the installer did. Updating *from* a build that predates it still runs that build's old uninstaller with the built-in check — which is safe only because the installer sweeps before invoking it.
