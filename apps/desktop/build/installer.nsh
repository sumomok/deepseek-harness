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
# Two hooks are defined:
#
#   customCheckAppRunning — the entire "is the app still running" step, for the
#                           installer (installSection.nsh) and the uninstaller
#                           (uninstaller.nsh, `un.checkAppRunning`).
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
