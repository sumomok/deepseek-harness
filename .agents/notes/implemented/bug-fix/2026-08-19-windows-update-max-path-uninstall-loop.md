# Agent Note: Windows update removes the old install by renaming it aside

Status: implemented

English | [中文](2026-08-19-windows-update-max-path-uninstall-loop.zh.md)

## Problem

Installing a new DSH Desktop over an existing per-machine install on Windows ended in a dialog the user could not get past:

> DSH Desktop 无法关闭。请手动关闭它，然后单击重试以继续。
>
> (DSH Desktop cannot be closed. Please close it manually, then click Retry to continue.)

Retry returned to the same dialog forever. Double-clicking the installer, running it as administrator, and letting the in-app updater run it all reproduced identically, with no DSH process running at any point.

The message names a running application, and three different places in the app-builder-lib NSIS templates show that same `$(appCannotBeClosed)` string (`include/allowOnlyOneInstallerInstance.nsh`, `include/extractAppPackage.nsh`, `include/installUtil.nsh`). Reasoning from the text alone pointed at the first one — the process check — which was wrong, and cost several rounds of fixes that could not work.

Observation on the failing machine settled it. Sampling the process table at 250 ms while the install ran recorded exactly five `old-uninstaller.exe` launches, ten seconds apart, and then the dialog, with no `powershell.exe` process check in between:

```
04:09:41  PROC old-uninstaller.exe  ppid=22712
04:09:51  PROC old-uninstaller.exe  ppid=22712
04:10:02  PROC old-uninstaller.exe  ppid=22712
04:10:12  PROC old-uninstaller.exe  ppid=22712
04:10:22  PROC old-uninstaller.exe  ppid=22712
04:10:32  WIN  [DSH Desktop 安装] | 重试(&R) | 取消 | DSH Desktop 无法关闭。
```

The dialog is the retry limit in `uninstallOldVersion` (`include/installUtil.nsh`), not the process check at all.

### Why the old uninstaller failed

The `--updated` uninstall stages every file out of `$INSTDIR` into `$PLUGINSDIR\old-install` before deleting it (`uninstaller.nsh`, `un.atomicRMDir`). `$PLUGINSDIR` is under `%TEMP%`, so each staged path is the temp prefix plus the file's path relative to `$INSTDIR`. For an install to `D:\soft\DSH Desktop` that prefix is 34 characters longer than the one it replaces, and the payload's deepest file sits 208 characters below `$INSTDIR`:

| path | prefix | deepest full path |
|---|---|---|
| `$INSTDIR` = `D:\soft\DSH Desktop` | 19 | 227 |
| `$PLUGINSDIR\old-install` (uninstall staging) | 53 | **261** |
| `$PLUGINSDIR\7z-out` (install extract) | 48 | 256 |

261 is one past MAX_PATH. NSIS is not long-path aware, so the `Rename` behind that move is a plain `MoveFileW`, and it fails. Measured directly against the file in question, with the same API and the same source:

```
dest 261 chars → MoveFileW FAIL win32err=3 (ERROR_PATH_NOT_FOUND)
dest 249 chars → MoveFileW OK
```

Nothing held the file: opening all 8848 installed files exclusively at the moment of failure found zero in use. `un.atomicRMDir` reports the name it could not move, the section prints `File is busy, aborting:` — which is untrue, and is what misdirected the investigation — restores what it had moved, and calls `Abort`, so the uninstaller exits with 2. `uninstallOldVersion` reads any non-zero exit as transient and retries five times before showing the dialog, whose Retry runs the same attempt again. Because the overlong path is the same path every time, the loop cannot converge. That same `Abort` is what surfaces as 「Failed to uninstall old application files…: 2」 when the box is answered with Cancel instead.

## Decision

`apps/desktop/build/installer.nsh` defines `customRemoveFiles`, the template's own hook for replacing that block (`uninstaller.nsh`, `!ifmacrodef customRemoveFiles`). On the update path it renames `$INSTDIR` **as one directory** into a numbered sibling (`~dsh-old<n>` beside it) and deletes that, instead of moving the tree file by file into `%TEMP%`.

Renaming the directory rather than its contents is what fixes the defect: every path below it keeps exactly the length it already had, so no file can be pushed past MAX_PATH however deep the payload grows. The staging name is a sibling rather than a suffix on `$INSTDIR` itself for the same reason — `…\DSH Desktop.old` lengthens every path beneath it, which is the bug being removed.

Two properties come along with it. The rename stays on the install volume, making it a metadata operation instead of the 322 MB cross-volume copy the per-file move performed — five times over, ten seconds each, before the dialog appeared. And it is still atomic, more so than what it replaces: one rename either takes the whole tree or leaves every file where it was, with no half-finished move to unwind. NTFS renames a directory even when it contains running images, which the per-file move could not survive.

When the rename cannot be done — no parent to write into, every staging name held by a directory that will not clear, or the rename itself refused — the fallback is `RMDir /r $INSTDIR`, what the template does for a plain uninstall. That gives up the rollback window in exchange for letting the install continue; aborting there is what produced a dialog with no way out.

The `customInit` process sweep stays, with its rationale corrected: it is not cross-volume moves that need the old processes gone, it is that a live process makes the directory delete leave a staging directory behind, and lets the extract write over files the old version is still reading.

### Native Windows packaging

`apps/desktop/scripts/package.ts` resolves subprocess names against `PATHEXT` and runs `.cmd`/`.bat` shims through `cmd.exe /d /s /c` with its own quoting. `spawn('pnpm', …)` is `ENOENT` on Windows because pnpm installs as `pnpm.cmd`; resolving to that shim then fails `EINVAL`, because Node has refused to spawn batch files directly since the CVE-2024-27980 fix. Without this the packaging pipeline only ran on macOS, and a Windows installer could be built but never built *and* tested on the machine that reproduces the bug.

`scripts/gen-desktop-icons.mjs` dispatches its downscaling on the host — `sips` on macOS, System.Drawing through PowerShell on Windows — and skips the `.icns` half off darwin, where `iconutil` has no counterpart and nothing consumes the product anyway. `build/icon.ico` is what a Windows build needs, and it is now produced on Windows.

The payload boot gate follows the host too. One pruned payload is booted for real to prove the prune rules cut no runtime content, and it used to be the macOS one unconditionally; on Windows that payload is missing exactly the win32 koffi and node-pty prebuilds pruning removed, so it fails on a native module instead of on anything the gate is meant to catch. Each target's payload is now derived once and the host's own is the one that boots.

The pipeline's MAX_PATH advisory is retargeted while its cause is understood. It used to warn about "the install prefix"; the binding budget is the installer's own extract staging under `%TEMP%`, and the message now reports how many characters are left against it.

## Verification

Both the failure and the fix were observed on the machine that reported them: an rc.11 per-machine install in `D:\soft\DSH Desktop`, updated to rc.12. Three runs separate what each change does.

| build | pre-clear | result |
|---|---|---|
| `customRemoveFiles` only | not in this installer | five `old-uninstaller.exe` launches ten seconds apart, then the dialog, then exit code 2 |
| both changes, first run | rename refused | identical, because the fallback is deliberately silent |
| both changes, second run | renamed on the first try | one `old-uninstaller.exe`, install completed, app launched |

The middle run is what added the rename retry. A directory cannot be renamed while any process holds it as its current directory, and `un.onInit` opens with `SetOutPath $INSTDIR` — so every old-uninstaller run stands in the directory it is about to remove. That run started four seconds after a previous installer had given up, with those handles still on their way out. The macro did what it is built to do (leave the old install untouched and let `uninstallOldVersion` proceed) and the install failed the old way, which is also why nothing said so: the fallback's `DetailPrint` is invisible, `installer.nsi` setting `SetDetailsPrint none` for every non-silent run.

The successful run: `D:\soft\DSH Desktop` renamed to `~dsh-old0` and the staged tree deleted 2.0 s later, the install directory down to the one uninstaller left for `uninstallOldVersion`, that uninstaller run once rather than five times, 12452 files extracted, `DisplayVersion` at `0.1.0-rc.12`, no staging directory left beside the install, and the app running with its embedded server.

The process sweep this fix depends on — the old app has to be out of the directory before it can be renamed — is [the app-running check](2026-08-19-installer-app-running-check.md)'s, reused from `customInit` rather than duplicated. That note's `customCheckAppRunning` covers the uninstaller; `customInit` is what covers the installer, whose `CHECK_APP_RUNNING` call is skipped under `${ifNot} ${UAC_IsInnerInstance}`.

## Alternatives considered

**Replace the process check with `customCheckAppRunning`.** The first reading of the dialog text, and the fix that was in flight when the machine evidence arrived. It cannot work: `CHECK_APP_RUNNING` runs in `installSection.nsh` before `uninstallOldVersion`, so reaching the uninstall loop already proves the process check passed. Recorded here because the message's wording will suggest it again.

**Shorten the bundled paths instead.** The overlong path is `resources\server\node_modules\@earendil-works\pi-ai\node_modules\@mistralai\mistralai\…` — a nested `node_modules` the server deploy leaves in place. Hoisting it would buy back roughly fifty characters everywhere at once, including for the install-time extract. It was not chosen as *the* fix because it leaves the defect in place and only moves the payload back under the limit: the next dependency that nests deeply reopens it, on a machine that will not be this one. It remains the right way to buy headroom, and the extract path has only three characters of it (see the table above).

**Delete `$INSTDIR` in place with no staging at all.** Simplest, and immune to MAX_PATH for the same reason the rename is. Rejected as the primary path because it discards the rollback the template intends: a locked file makes `RMDir /r` skip it silently and report success, mixing stale files into the new install. It is kept as the fallback, where the alternative is not rolling back but hanging.

**Make the move long-path aware.** `MoveFileW` takes paths beyond MAX_PATH behind a `\\?\` prefix, but the call sits in app-builder-lib's NSIS templates, and this repo does not modify upstream — customization lives in `apps/`, plugins, and the composition layer.

## Consequences

The update path no longer performs a 322 MB cross-volume copy per attempt: removing the old version costs a directory rename plus a same-volume delete, rather than the ten seconds per try that preceded the dialog.

Rollback narrows in one case. If the whole-directory rename fails, the fallback deletes in place and there is no restore. The template would have aborted instead, which is the behavior this note exists to remove.

`~dsh-old<n>` directories can be left beside the install directory when an install is killed between the rename and the delete. The next update clears the name before reusing it, and tries up to twenty names before falling back.

Packaging runs natively on Windows, which is what allows a build to be verified by installing it. macOS cross-builds are unaffected and remain structurally verified only.

The install-time extract path (`$PLUGINSDIR\7z-out`) is not addressed here and has three characters of MAX_PATH headroom. It has its own `$(appCannotBeClosed)` retry loop (`include/extractAppPackage.nsh`), reachable by the same mechanism, and no template hook to replace. Shortening the payload's deepest path is the mitigation.
