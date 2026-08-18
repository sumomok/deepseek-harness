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
# Two hooks are defined here, both on the update path only:
#
#   customInit       — clears the old version's processes out of $INSTDIR before
#                      the old uninstaller runs (installer.nsi, .onInit).
#   customFinishPage — replaces the wizard's finish page so an update needs no
#                      click and restarts the app itself (assistedInstaller.nsh).

# ── Process sweep ───────────────────────────────────────────────────────────
#
# What goes wrong without it: the update runs the OLD uninstaller with
# `/S ... --updated _?=$INSTDIR` (`include/installUtil.nsh`, `uninstallOldVersion`),
# whose uninstall section takes the `${if} ${isUpdated}` branch and renames
# every file in $INSTDIR into `$PLUGINSDIR\old-install` (`uninstaller.nsh`,
# `un.atomicRMDir`). $PLUGINSDIR is under %TEMP%, so when the install directory
# is on another volume than the user profile each of those renames is a
# cross-volume `MoveFile` — a copy followed by a delete — and Windows refuses to
# delete a file whose image is mapped by a live process. One failure aborts the
# whole uninstall with exit code 2, which the new installer reports as
# 「Failed to uninstall old application files…: 2」 (`handleUninstallResult`,
# whose MessageBox carries no `/SD` and so is shown even under `/S`).
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
# to move it and waiting for it cannot succeed. It is killed at once, and
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
