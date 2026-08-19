# Custom NSIS include for the DSH Desktop installer.
#
# app-builder-lib picks this file up by name, not by configuration:
# `NsisTarget.computeCommonInstallerScriptHeader` resolves
# `getResource(options.include, "installer.nsh")` against the buildResources
# directory (`electron-builder.yml` → `directories.buildResources: build`), so
# `build/installer.nsh` is prepended to the generated script and every macro it
# defines is picked up by the `!ifmacrodef` hooks in the templates. The file is
# therefore source, not a build product — `.gitignore` lists the generated
# icons individually so this one stays tracked.
#
# Three hooks are defined here:
#
#   customInit        — clears the old version's processes out of $INSTDIR
#                       before the old uninstaller runs (installer.nsi,
#                       .onInit). Update path only.
#   customRemoveFiles — replaces the old uninstaller's per-file staging of
#                       $INSTDIR, whose destination paths run past MAX_PATH
#                       (uninstaller.nsh, un.atomicRMDir). Both paths.
#   customPageAfterChangeDir
#                     — clears the old install before its own uninstaller is
#                       asked to, so an update off a build that predates
#                       customRemoveFiles still works (assistedInstaller.nsh).
#                       Update and first-install paths; a no-op when there is
#                       no recorded install.
#   customFinishPage  — replaces the wizard's finish page so an update needs no
#                       click and restarts the app itself
#                       (assistedInstaller.nsh). Update path only.

# ── Process sweep ───────────────────────────────────────────────────────────
#
# What goes wrong without it: the update replaces $INSTDIR while the version
# being replaced still has processes of its own inside it, and Windows will not
# delete a file whose image is mapped by a live process. `customRemoveFiles`
# below renames the whole directory aside and deletes it, and a live process
# turns that delete into a staging directory left on disk; the extract that
# follows then writes over files the old version is still reading. Either way
# the failure is the old processes, not the files, so they are cleared here —
# in `.onInit`, before `uninstallOldVersion` runs at all.
#
# Three kinds of process can hold such a file, and they need different handling:
#
#   ${APP_EXECUTABLE_FILENAME}  the app that was asked to quit a moment ago,
#   node.exe                    its embedded server, under resources\runtime,
#   elevate.exe                 the updater's own launcher, under resources.
#
# The first two are expected to be on their way out, so they are waited for and
# only then killed, each with its process tree — the server's children (shells,
# language servers) hold the same files it does, and the template's own cleanup
# reaches neither (`_CHECK_APP_RUNNING` stops matched processes by pid without
# their children, and its no-PowerShell fallback matches one image name).
#
# elevate.exe is different: electron-updater starts it from `process.resourcesPath`
# — inside $INSTDIR — and it waits on the installer (`ShellExecuteExW` +
# `WaitForSingleObject`), so it will still be running when the uninstaller tries
# to remove it and waiting for it cannot succeed. It is killed at once, and
# **without** `/T`: this installer is its child, so a tree kill would end the
# install. Nothing waits on its exit code once the app has quit.
#
# Matching is by executable path, which is what makes killing safe: it covers
# the bundled node.exe without naming a `node.exe` that belongs to anything else
# on the machine. `perMachine: true` means one install location and no mode
# page, so $INSTDIR here is the only place this product is ever installed.

# Processes under the install directory that this product owns. Written as
# PowerShell fragments and shared by the wait and the kill so the two cannot
# drift apart. `$$` emits one literal `$` into the generated command.
!define dshUnderInstdir "$$_.Path -and $$_.Path.StartsWith($$root, 'CurrentCultureIgnoreCase')"
!define dshAppOrServer "${dshUnderInstdir} -and $$names -contains $$_.Name"
!define dshElevateHelper "${dshUnderInstdir} -and $$_.Name -eq 'elevate.exe'"

# How long the app and its server may take to leave on their own before they
# are killed. The whole wait happens inside one PowerShell process, so the
# budget is wall-clock time rather than a poll count paying for a process start.
!define dshQuitGraceSeconds 10

!macro customInit
  Var /GLOBAL dshPowerShell
  Var /GLOBAL dshSweep
  StrCpy $dshPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

  # Move this process's current directory out of $INSTDIR first. A directory
  # that is any process's current directory cannot be renamed or deleted, and
  # `customRemoveFiles` below removes the old install by renaming $INSTDIR
  # whole — so the installer must not be standing in it. It can be: an update
  # is started by electron-updater from the running app, and an app launched
  # from its shortcut has the install directory as its working directory,
  # which elevate.exe and the installer both inherit. The install section sets
  # $OUTDIR to $INSTDIR again before it writes anything there.
  SetOutPath $TEMP

  nsExec::Exec /TIMEOUT=30000 `"$dshPowerShell" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; try { $$root=('$INSTDIR').TrimEnd('\')+'\'; $$names=@('${APP_EXECUTABLE_FILENAME}','node.exe'); Get-CimInstance Win32_Process | Where-Object { ${dshElevateHelper} } | ForEach-Object { & '$SYSDIR\taskkill.exe' /PID $$_.ProcessId /F | Out-Null }; $$deadline=(Get-Date).AddSeconds(${dshQuitGraceSeconds}); while ((Get-Date) -lt $$deadline) { if (@(Get-CimInstance Win32_Process | Where-Object { ${dshAppOrServer} }).Count -eq 0) { exit 0 }; Start-Sleep -Milliseconds 500 }; Get-CimInstance Win32_Process | Where-Object { ${dshAppOrServer} } | ForEach-Object { & '$SYSDIR\taskkill.exe' /PID $$_.ProcessId /T /F | Out-Null }; Start-Sleep -Milliseconds 500; exit 0 } catch { exit 1 }"`
  Pop $dshSweep

  ${if} $dshSweep != 0
    # No usable PowerShell, or WMI refused the query. Only the app can be
    # matched by image name — `node.exe` is far too common a name to kill by
    # name — but a tree kill of the app takes the server it started with it.
    nsExec::Exec `"$SYSDIR\taskkill.exe" /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
    Pop $dshSweep
    Sleep 1000
  ${endif}
!macroend

# ── Old version removal ─────────────────────────────────────────────────────
#
# What goes wrong without it: the update runs the old uninstaller with
# `--updated`, whose uninstall section stages every file out of $INSTDIR into
# `$PLUGINSDIR\old-install` and only then deletes it (`uninstaller.nsh`,
# `un.atomicRMDir`). $PLUGINSDIR is under %TEMP%, so each staged path is the
# temp directory's prefix plus the file's path relative to $INSTDIR — for an
# install to `D:\soft\DSH Desktop` that prefix is 34 characters longer than the
# one it replaces.
#
# The deepest file the server closure ships sits 208 characters below $INSTDIR:
#
#   resources\server\node_modules\@earendil-works\pi-ai\node_modules
#     \@mistralai\mistralai\esm\models\operations\getchatcompletionfieldoptions
#     countsv1observabilitychatcompletionfieldsfieldnameoptionscountspost.js
#
# 53 + 208 = 261, one character past MAX_PATH. NSIS is not long-path aware, so
# the `Rename` behind that move is a plain `MoveFileW` and fails with
# ERROR_PATH_NOT_FOUND (3). `un.atomicRMDir` hands back the name it could not
# move, the section prints `File is busy, aborting:` — which is misleading,
# nothing holds the file — restores what it had already moved, and `Abort`s,
# so the uninstaller exits with 2.
#
# `uninstallOldVersion` (`include/installUtil.nsh`) reads any non-zero exit as
# transient: it sleeps a second and runs the uninstaller again, five times over,
# and then shows `$(appCannotBeClosed)` — 「DSH Desktop 无法关闭」— whose Retry
# jumps straight back to another attempt. The overlong path is the same path
# every time, so the loop cannot converge and Retry never gets anywhere. The
# same abort is what surfaces as 「Failed to uninstall old application files…:
# 2」 when that box is answered with Cancel instead.
#
# `customRemoveFiles` is the template's own hook for replacing that block
# (`uninstaller.nsh`, `!ifmacrodef customRemoveFiles`), and replacing it is what
# removes the failure at its source. $INSTDIR is renamed **as one directory**
# into a sibling of itself, which
#
#   * leaves every path below it exactly as long as it already was, so no file
#     can be pushed past MAX_PATH however deep the payload grows,
#   * stays on the install volume, making it a metadata rename instead of the
#     322 MB cross-volume copy the per-file move performed — five times, ten
#     seconds each, before the dialog even appeared, and
#   * is still atomic, and more so: one rename either takes the whole tree or
#     leaves every file where it was, with no half-finished move to unwind.
#
# NTFS renames a directory even when it contains running images, so this also
# survives what the per-file move could not.
#
# The staging name is a sibling rather than a suffix on $INSTDIR itself
# (`…\DSH Desktop.old`): a suffix lengthens every path below it, which is the
# bug this macro exists to remove.
#
# When the rename cannot be done — no parent to write into, every staging name
# taken by a directory that will not clear, or the rename refused — the
# fallback is `RMDir /r $INSTDIR`, exactly what the template does for a plain
# uninstall. That gives up the rollback window, but a best-effort delete lets
# the install carry on; aborting here is what produced a dialog the user could
# not get past.

# Staging directory beside the install directory, numbered so one left behind
# by an install that was killed mid-rename cannot block the next one. Shared by
# both places that move an install aside: `customRemoveFiles` in the
# uninstaller and `customPageAfterChangeDir` in the installer.
!define dshStageDirName "~dsh-old"
!define dshStageNameAttempts 20

# How many times the installer re-tries renaming the old install aside. The
# handles that block it belong to a previous attempt's processes and go away
# on their own; this is a couple of seconds of patience, not a poll loop.
!define dshStageRenameAttempts 6

!macro customRemoveFiles
  Var /GLOBAL dshStageParent
  Var /GLOBAL dshStagePath
  Var /GLOBAL dshStageIndex

  # `un.onInit` runs `SetOutPath $INSTDIR`, and a directory that is a process's
  # current directory cannot be renamed. Leave it before touching anything.
  SetOutPath $TEMP

  ${ifNot} ${isUpdated}
    # A plain uninstall never staged anything, and deleting in place walks the
    # original paths, which were short enough to install in the first place.
    Goto dshRemoveInPlace
  ${endif}

  ${StdUtils.GetParentPath} $dshStageParent "$INSTDIR"
  ${if} $dshStageParent == ""
  ${orIf} $dshStageParent == "$INSTDIR"
    DetailPrint "No parent directory to stage $INSTDIR into; removing it in place."
    Goto dshRemoveInPlace
  ${endif}

  StrCpy $dshStageIndex 0

  dshPickStage:
    StrCpy $dshStagePath "$dshStageParent\${dshStageDirName}$dshStageIndex"
    ${ifNot} ${FileExists} "$dshStagePath"
      Goto dshStagePicked
    ${endif}

    # Left over from an install that did not get to delete it. Clear it and
    # take the name back; only step to the next one if it will not go.
    RMDir /r "$dshStagePath"
    ${ifNot} ${FileExists} "$dshStagePath"
      Goto dshStagePicked
    ${endif}

    IntOp $dshStageIndex $dshStageIndex + 1
    ${if} $dshStageIndex < ${dshStageNameAttempts}
      Goto dshPickStage
    ${endif}

    DetailPrint "No free staging name beside $INSTDIR; removing it in place."
    Goto dshRemoveInPlace

  dshStagePicked:
    ClearErrors
    Rename "$INSTDIR" "$dshStagePath"
    ${ifNot} ${Errors}
      RMDir /r "$dshStagePath"
      Goto dshFilesRemoved
    ${endif}
    DetailPrint "Could not rename $INSTDIR aside; removing it in place."

  dshRemoveInPlace:
    RMDir /r "$INSTDIR"

  dshFilesRemoved:
!macroend

# ── Old install pre-clear ───────────────────────────────────────────────────
#
# `customRemoveFiles` below fixes the uninstaller this build ships. It cannot
# fix the update that installs this build, because that update does not run
# this build's uninstaller: `uninstallOldVersion` (`include/installUtil.nsh`)
# reads `UninstallString` from the registry and runs the uninstaller belonging
# to the version being replaced. Every install made before that macro existed
# therefore still stages $INSTDIR file by file into `$PLUGINSDIR\old-install`,
# still runs one destination path past MAX_PATH, still aborts with 2, and still
# ends on a 「DSH Desktop 无法关闭」 dialog whose Retry cannot converge. Shipping
# only the uninstaller-side fix would leave every existing install stuck on the
# release it is on, this machine's included.
#
# So the installer clears the old install itself, before handing over. What is
# left behind for `uninstallOldVersion` is a directory holding nothing but the
# old uninstaller, which it then runs on its ordinary success path: the one
# file it has to stage is short enough to move, and `un.atomicRMDir` ignores
# rename failures on that name anyway (`uninstaller.nsh`). Its registry and
# shortcut cleanup still happen, and the result it reports is 0.
#
# The timing has exactly one window. `.onInit` is too early — the directory
# page has not been shown yet, so an install the user is still free to cancel
# would already have deleted the version they are running. The install section
# is too late: `uninstallOldVersion` is its third statement, with no hook in
# front of it. `customPageAfterChangeDir` sits between the two
# (`assistedInstaller.nsh`), which is after the user commits and before the
# section starts. `perMachine: true` runs the whole page sequence inside the
# UAC inner instance, so this also runs with the rights it needs — the same
# reason `CHECK_APP_RUNNING` never runs at all here, guarded as it is by
# `${ifNot} ${UAC_IsInnerInstance}` in `installSection.nsh`.
#
# The directory to clear is read from the registry and never derived from
# $INSTDIR. The directory page's result is not sanitized until the INSTFILES
# pre function (`assistedInstaller.nsh`, `instFilesPre`, which appends the
# product folder when the user picked a bare parent), so at this point $INSTDIR
# can still be `D:\soft` for an install into `D:\soft\DSH Desktop`. Renaming
# that aside would take everything else the user keeps there with it.
# `uninstallOldVersion` resolves the old install from the same key.
#
# Two conditions gate the whole thing, and they are checked rather than
# assumed, because what follows is a recursive delete: the recorded directory
# must exist, and it must contain both this product's executable and its
# uninstaller. A directory that holds those two is an install of ours.
#
# Nothing here aborts the install. Every failure path leaves the old install
# exactly as it was and lets `uninstallOldVersion` proceed — which is the
# behavior without this macro, no worse for having tried.
#
# The rename is a metadata operation and the delete that follows it is not:
# clearing this product measures ~2 s for its file count on the volume it
# installs to, inside a page callback that paints nothing while it runs. That
# is under what reads as a hang, which is why it is here rather than split
# across `customInstall` where the progress bar would be up. Re-measure before
# assuming it still holds if the payload's file count grows by an order.
#
# A silent install (`/S`) does not get this: NSIS runs no page callbacks when
# there is no UI, so the hook never fires and such an install still meets the
# old uninstaller's staging. Nothing here uses `/S` — `quitAndInstall(false,
# true)` in `src/updater.ts` asks for a visible install for its own reasons —
# and a silent install could not have survived the old path either, since
# `handleUninstallResult`'s failure MessageBox carries no `/SD` and blocks with
# nobody there to answer it.

!macro customPageAfterChangeDir
  Function dshClearOldInstall
    Push $0
    Push $1
    Push $2
    Push $3
    Push $4

    ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ${if} $0 == ""
      Goto dshClearDone
    ${endif}
    # The recorded value becomes a rename source, and a trailing separator is
    # enough to make that fail. Normalize rather than trust how it was written.
    ${StdUtils.NormalizePath} $0 "$0"
    ${ifNot} ${FileExists} "$0\${APP_EXECUTABLE_FILENAME}"
      Goto dshClearDone
    ${endif}
    ${ifNot} ${FileExists} "$0\${UNINSTALL_FILENAME}"
      Goto dshClearDone
    ${endif}

    # Same staging shape as `customRemoveFiles`: one rename of the whole
    # directory into a sibling of itself, so no path below it gets longer and
    # the move stays on the install volume. The two cannot share an
    # implementation — NSIS compiles installer and uninstaller code separately
    # and an uninstaller function has to be `un.` prefixed — so they share the
    # naming and the reasoning instead.
    ${StdUtils.GetParentPath} $1 "$0"
    ${if} $1 == ""
    ${orIf} $1 == "$0"
      Goto dshClearDone
    ${endif}

    StrCpy $2 0

    dshClearPick:
      StrCpy $3 "$1\${dshStageDirName}$2"
      ${ifNot} ${FileExists} "$3"
        Goto dshClearPicked
      ${endif}
      RMDir /r "$3"
      ${ifNot} ${FileExists} "$3"
        Goto dshClearPicked
      ${endif}
      IntOp $2 $2 + 1
      ${if} $2 < ${dshStageNameAttempts}
        Goto dshClearPick
      ${endif}
      Goto dshClearDone

    dshClearPicked:
      # A directory cannot be renamed while any process holds it as its current
      # directory, and the processes that do are exactly the ones a previous
      # attempt leaves behind for a moment: `un.onInit` opens with
      # `SetOutPath $INSTDIR` (`uninstaller.nsh`), so every old-uninstaller run
      # stands in the directory it is about to remove. Observed: an install
      # started four seconds after a previous one gave up renamed nothing and
      # fell through to the old path, while the same build minutes later
      # renamed on the first try. A handle that is on its way out should not
      # get to decide whether the fix runs, so the rename is retried on a short
      # fixed budget before giving up.
      StrCpy $4 0

    dshClearRename:
      ClearErrors
      Rename "$0" "$3"
      ${ifNot} ${Errors}
        Goto dshClearRenamed
      ${endif}
      IntOp $4 $4 + 1
      ${if} $4 < ${dshStageRenameAttempts}
        Sleep 500
        Goto dshClearRename
      ${endif}
      DetailPrint "Could not clear the old install at $0; leaving it to its own uninstaller."
      Goto dshClearDone

    dshClearRenamed:
      # Hand `uninstallOldVersion` a directory with just the uninstaller in it.
      # If the copy fails the old uninstaller is gone, which that function
      # treats as "not able to launch uninstaller" — a DetailPrint and a
      # return, not a failure (`handleUninstallResult`) — so the install still
      # goes through and the new build rewrites the registry entries and
      # shortcuts the old uninstaller would have removed.
      CreateDirectory "$0"
      CopyFiles /SILENT "$3\${UNINSTALL_FILENAME}" "$0"
      RMDir /r "$3"

    dshClearDone:
      Pop $4
      Pop $3
      Pop $2
      Pop $1
      Pop $0
      # Never a page: this hook is the only place the work fits, not something
      # to show.
      Abort
  FunctionEnd

  Page custom dshClearOldInstall
!macroend

# ── Finish page ─────────────────────────────────────────────────────────────
#
# An update installs with the progress page visible and no wizard: the
# directory page is already skipped for `--updated` runs by the template
# (`assistedInstaller.nsh` → `skipPageIfUpdated`), which leaves the finish page
# as the only thing standing between a finished install and the app being back.
# Aborting in its PRE skips it, and MUI has already set `SetAutoClose true` from
# `.onGUIInit` (Contrib/Modern UI 2/Pages/Finish.nsh) — that define exists
# because the finish page needs the progress page not to wait, and it applies
# just as well when the finish page then removes itself.
#
# Restarting the app is ours to do for the same reason: the template's own
# relaunch is `${if} ${isForceRun} ${andIf} ${Silent}` (installSection.nsh), so
# a visible install never reaches it however `--force-run` is passed.
!macro customFinishPage
  Function dshFinishPre
    ${if} ${isUpdated}
      # ExecShellAsUser hands the launch to the shell, so the app starts with
      # the user's own token rather than inheriting the installer's elevated
      # one — an elevated app would write files the ordinary session cannot
      # read back.
      ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
      Abort
    ${endif}
  FunctionEnd
  !define MUI_PAGE_CUSTOMFUNCTION_PRE dshFinishPre

  # A first install still ends on the ordinary finish page with its run
  # checkbox; only the update path skips it.
  Function dshStartApp
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" ""
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_FUNCTION "dshStartApp"
  !insertmacro MUI_PAGE_FINISH
!macroend
