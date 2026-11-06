# Custom NSIS include for the DSH Desktop installer.
#
# app-builder-lib picks this file up by name, not by configuration:
# `NsisTarget.computeCommonInstallerScriptHeader` resolves
# `getResource(options.include, "installer.nsh")` against the buildResources
# directory (`electron-builder.yml` → `directories.buildResources: build`) and
# prepends it to the generated script. Both compilations receive it — the
# uninstaller is the same `installer.nsi` compiled with `-DBUILD_UNINSTALLER` —
# so a macro defined here is picked up by the `!ifmacrodef` hooks on both sides,
# and everything here must be legal inside an `un.` function: no `Call`, no
# function definitions, plugin calls and inline LogicLib only. The file is
# source, not a build product — `.gitignore` lists the generated icons
# individually so this one stays tracked.
#
# Six hooks are defined:
#
#   customCheckAppRunning — the entire "is the app still running" step, for the
#                           installer (installSection.nsh) and the uninstaller
#                           (uninstaller.nsh, `un.checkAppRunning`).
#   customInit            — the same sweep at `.onInit`, which is the only point
#                           the installer actually reaches (installer.nsi).
#   customRemoveFiles     — replaces the uninstaller's per-file staging of
#                           $INSTDIR, whose destination paths run past MAX_PATH
#                           (uninstaller.nsh, un.atomicRMDir).
#   customPageAfterChangeDir
#                         — clears the old install before its own uninstaller is
#                           asked to, so an update off a build that predates
#                           customRemoveFiles still works
#                           (assistedInstaller.nsh).
#   customInstall         — unpacks the sealed third-party half of the server
#                           closure, which ships as one archive so its files are
#                           created once rather than twice (installSection.nsh).
#                           Windows only.
#   customFinishPage      — the wizard's finish page, so an update needs no
#                           click and restarts the app itself.

# ── Why the template's own check cannot be used ─────────────────────────────
#
# `CHECK_APP_RUNNING` (include/allowOnlyOneInstallerInstance.nsh:32-43) hands the
# whole step to `customCheckAppRunning` when one is defined, and that is the only
# usable granularity: the pieces underneath are wrong in ways a wrapper cannot
# repair.
#
# `FIND_PROCESS` (:64-79) takes a file name and, on its PowerShell branch (:66),
# ignores it: it counts every process whose executable path starts with
# `$INSTDIR` and answers "the app is running" whenever that count is non-zero.
# The prefix is used raw, with no trailing separator, and .NET's
# `String.StartsWith("")` is true for every string — so an `$INSTDIR` that did
# not resolve makes **every process on the machine** the app, the installer
# included. `KILL_PROCESS` (:81-103) then walks that same match set with
# `Stop-Process -Force`, most of which fails, `_CHECK_APP_RUNNING` (:105-166)
# finds survivors on its second pass (`$R1 > 1`), and the run ends at the
# `appCannotBeClosed` box whose Retry re-enters the identical loop. A real
# machine reached exactly that state with an install directory holding no
# running process at all.
#
# `KILL_PROCESS` is also pid-only, never a process tree, and its no-PowerShell
# branch matches one image name — so the app's server, whose children hold the
# same files it does, survives either branch.

# ── What this check does instead ────────────────────────────────────────────
#
# Three kinds of process can hold a file inside the install directory:
#
#   ${APP_EXECUTABLE_FILENAME}  the app, asked to quit a moment ago,
#   node.exe                    its embedded server, under resources\runtime,
#   elevate.exe                 the updater's own launcher, under resources.
#
# The first two are on their way out, so they are waited for and only then
# killed, each with its process tree — the server's children (shells, language
# servers) hold the same files it does.
#
# elevate.exe is the opposite in both directions. It cannot be waited for:
# electron-updater starts it from `process.resourcesPath`, inside the install
# directory, and it holds `ShellExecuteExW` + `WaitForSingleObject` on this
# installer for the whole run, so waiting for it is waiting for ourselves. And
# it must never be tree-killed: this installer is its child. It is stopped
# first, alone, and without `/T`, which also detaches this process from the
# app's descendants before anything else is killed with `/T`.
#
# Three invariants hold whatever the machine looks like:
#
#   1. `$INSTDIR` is not trusted. A path prefix is used only when it is an
#      absolute drive path longer than a volume root, the directory exists, and
#      it holds this product's executable. Anything else falls back to matching
#      exact image names, which is why `node.exe` is only ever matched under a
#      verified prefix — every other `node` on the machine belongs to someone
#      else. `elevate.exe` is safe by name because the fallback reaches it only
#      through this process's own ancestor chain.
#   2. This process is never a match. Its pid is excluded from every kill set,
#      and the two image names it matches by are neither the installer's
#      (`… Setup <version>.exe`) nor the uninstaller's (`Uninstall ….exe`).
#   3. Nothing here opens a dialog. A blocking box the user cannot satisfy is
#      how the template's version dead-ends; a launcher of ours holding a file
#      is this installer's problem to solve, not the user's.

# How long the app and its server may take to leave on their own before they
# are killed. The whole wait happens inside one PowerShell process, so the
# budget is wall-clock time rather than a poll count paying for a process start.
!define dshQuitGraceSeconds 10

# Upper bound on the sweep, generous against a machine that is paging: the
# grace period plus the kills. Expiry is reported as a non-zero result and
# takes the fallback branch.
!define dshSweepTimeout 45000

# The two match sets, written as PowerShell fragments and shared by the wait and
# the kills so they cannot drift apart. `$$` emits one literal `$`.
#
# `dshOurs`: this product's app and server. The image name must match exactly;
# the path must match too whenever a prefix was verified.
# `dshHelper`: the updater's launcher under the verified prefix.
!define dshOurs "$$_.ProcessId -ne $$self -and $$names -contains $$_.Name -and (-not $$root -or ($$_.Path -and $$_.Path.StartsWith($$root, 'CurrentCultureIgnoreCase')))"
!define dshHelper "$$_.Name -eq 'elevate.exe' -and $$_.Path -and $$_.Path.StartsWith($$root, 'CurrentCultureIgnoreCase')"

# Declared once per compilation. `CHECK_APP_RUNNING` is inserted once in the
# installer (inside the install section) and once in the uninstaller (inside
# `un.checkAppRunning`), and the guard keeps a second insertion from redeclaring.
!macro dshDeclareVars
  !ifndef DSH_VARS_DECLARED
    !define DSH_VARS_DECLARED
    Var /GLOBAL dshRoot
    Var /GLOBAL dshSelf
    Var /GLOBAL dshProbe
    Var /GLOBAL dshLen
    Var /GLOBAL dshResult
  !endif
!macroend

# Resolve $dshRoot to an install directory safe to use as a path prefix, or to
# the empty string when there is none. `$INSTDIR` reaches this macro from four
# different places — the registry, the wizard's directory page, the uninstaller's
# `_?=` argument, and a compiled-in default — and an unresolved one is the input
# that turns a prefix match into "every process on this machine".
#
# The prefix always ends in a separator, so a sibling directory whose name
# begins with the same characters cannot match.
!macro dshResolveRoot
  StrCpy $dshRoot ""
  StrCpy $dshProbe $INSTDIR 2 1
  StrLen $dshLen $INSTDIR
  ${if} $dshProbe == ":\"
  ${andIf} $dshLen > 3
  ${andIf} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    StrCpy $dshProbe $INSTDIR "" -1
    ${if} $dshProbe == "\"
      StrCpy $dshRoot "$INSTDIR"
    ${else}
      StrCpy $dshRoot "$INSTDIR\"
    ${endif}
    DetailPrint "Stopping this product's processes under $dshRoot"
  ${else}
    DetailPrint "No verified install directory; stopping by exact image name only"
  ${endif}
!macroend

# Clear this product's processes out of the install directory.
#
# The sweep runs in one PowerShell process rather than one per poll, because the
# query costs more than the 500 ms between polls. It reports 0 once it has done
# its work, 3 when the machine has no `Get-CimInstance`, and whatever PowerShell
# exits with otherwise — an install path containing a single quote parses as a
# syntax error here, which is a fallback rather than a wrong match set.
#
# The fallback can only work by image name: it force-stops `elevate.exe`, alone
# and without `/T`, and tree-kills the app, which takes the server it started
# with it. A bare `node.exe` is never killed there.
!macro dshSweep
  !insertmacro dshDeclareVars
  System::Call 'kernel32::GetCurrentProcessId()i.s'
  Pop $dshSelf
  !insertmacro dshResolveRoot

  nsExec::Exec /TIMEOUT=${dshSweepTimeout} `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='SilentlyContinue'; if (-not (Get-Command Get-CimInstance)) { exit 3 }; $$self=$dshSelf; $$root='$dshRoot'; $$names=@('${APP_EXECUTABLE_FILENAME}'); if ($$root) { $$names+='node.exe' }; function M { Get-CimInstance Win32_Process | Where-Object { ${dshOurs} } }; $$p=$$self; for ($$i=0; $$i -lt 8 -and $$p; $$i++) { $$q=Get-CimInstance Win32_Process -Filter ('ProcessId='+$$p); if (-not $$q) { break }; if ($$q.Name -eq 'elevate.exe' -and $$p -ne $$self) { Stop-Process -Id $$p -Force; break }; $$p=$$q.ParentProcessId }; if ($$root) { Get-CimInstance Win32_Process | Where-Object { ${dshHelper} } | ForEach-Object { Stop-Process -Id $$_.ProcessId -Force } }; $$d=(Get-Date).AddSeconds(${dshQuitGraceSeconds}); while ((Get-Date) -lt $$d -and @(M).Count -gt 0) { Start-Sleep -Milliseconds 500 }; M | ForEach-Object { & '$SYSDIR\taskkill.exe' /PID $$_.ProcessId /T /F | Out-Null }; Start-Sleep -Milliseconds 300; exit 0"`
  Pop $dshResult

  ${if} $dshResult != 0
    DetailPrint "PowerShell sweep unavailable ($dshResult); stopping by image name"
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /IM "elevate.exe"`
    Pop $dshProbe
    nsExec::Exec `"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
    Pop $dshProbe
    Sleep 1000
  ${endif}
!macroend

# The install section reaches this before `uninstallOldVersion`, silent or not
# (installSection.nsh), and the uninstaller reaches it before `un.atomicRMDir`
# from either its silent `un.onInit` path or its section (uninstaller.nsh). That
# covers every point at which a live process can hold a file the next step has
# to move, which is why there is no second copy of this in `customInit`: `.onInit`
# runs before the directory page has settled `$INSTDIR`, so a sweep there would
# be matching against a value that is still provisional.
!macro customCheckAppRunning
  !insertmacro dshSweep
!macroend

# ── Process sweep on the installer's side ───────────────────────────────────
#
# `customCheckAppRunning` above is inserted where the templates offer it, and in
# this product's configuration the installer never reaches one of those two
# places: `CHECK_APP_RUNNING` sits behind `${ifNot} ${UAC_IsInnerInstance}`
# (`installSection.nsh`), while `perMachine: true` with `oneClick: false` runs
# the page sequence and the section inside the UAC inner instance, where that
# condition is false. The uninstaller still reaches it through
# `un.checkAppRunning`, so the hook earns its place — but on the installer's
# side nothing sweeps without this one.
#
# The sweep also has to precede `customPageAfterChangeDir` below, which renames
# the old install aside and cannot do that while the old app still holds the
# directory. Pages run before the section, so even a reachable
# `CHECK_APP_RUNNING` would be too late for it.
#
# The objection to sweeping from `.onInit` — that the directory page has not
# settled `$INSTDIR` yet — is answered by `dshResolveRoot` rather than by moving
# the sweep. A directory that does not exist, or does not hold this product's
# executable, yields no prefix at all and the sweep falls back to exact image
# names. And at `.onInit` the value comes from `initMultiUser` reading
# `InstallLocation` out of the registry: the old install's own recorded
# location, which is the most accurate input this sweep ever gets.
!macro customInit
  # A directory that is any process's current directory can be neither renamed
  # nor deleted, and `.onInit` opens with `SetOutPath $INSTDIR`
  # (`installer.nsi`), which makes this process one of them. It can be one
  # already: an update is started by electron-updater from the running app, and
  # an app launched from its shortcut has the install directory as its working
  # directory, which elevate.exe and the installer both inherit. The install
  # section sets $OUTDIR back to $INSTDIR before it writes anything there.
  SetOutPath $TEMP
  !insertmacro dshSweep
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
# reason `CHECK_APP_RUNNING` never runs on the installer's side, guarded by
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

# ── Server dependencies ────────────────────────────────────────────────────────
#
# `after-pack` seals the third-party half of the server closure into
# `resources\server-deps.7z` instead of shipping it as loose files, and this is
# where it comes back out. An install's cost is its file count: 98% of the copy
# is per-file overhead, and the installer pays that count twice, once
# decompressing the app package into %TEMP% and once copying it here. One
# archive is one file in both passes, so those files are created once rather
# than twice.
#
# The plugin is the same `Nsis7z` the template uses for the app package itself,
# so nothing new ships to make this work. `customInstall` runs after
# `installApplicationFiles`, which is when the archive is on disk and the
# directory it belongs in exists.
#
# A failure here leaves an install that cannot start, so unlike the sweep and
# the pre-clear this one is fatal rather than best-effort: the archive is
# always present in a Windows build, and its absence means the package is not
# the one this macro was built for.
!macro customInstall
  ${if} ${FileExists} "$INSTDIR\resources\server-deps.7z"
    DetailPrint "Unpacking server dependencies"
    SetOutPath "$INSTDIR\resources\server\node_modules"
    Nsis7z::Extract "$INSTDIR\resources\server-deps.7z"
    Delete "$INSTDIR\resources\server-deps.7z"
    SetOutPath "$INSTDIR"
  ${else}
    DetailPrint "No server-deps archive; the payload is already unpacked."
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
