# Agent Note: Explorer starts with a visible window

Status: implemented

English | [中文](2026-09-27-explorer-visible-window.zh.md)

## Problem

On the Windows desktop client, **Open** and **Show in folder** did nothing visible and logged nothing. Both reach [`runExplorer`](../../../../packages/util/native-command/src/path-opener.ts), which runs `explorer.exe` through `runNativeCommand`. That runner started every command with `execFile(command, args, { encoding: 'utf8', signal, windowsHide: true })`. Windows applies the hidden show state from the start information to the first window a program shows, and for Explorer that window is the folder or selection window the call exists to open. Explorer exits 0 or 1 in either case, and [the Windows open handoff](2026-09-22-windows-open-through-shell-resolution.md) accepts both as success, so no failure reached the log.

The cause was isolated on Windows 11 25H2 build 26200.9457 with the Node binary bundled in the desktop client. The same call, `execFile('explorer.exe', ['/select,', fileURL], { windowsHide: X })`, showed no window with `X = true` and opened Explorer with the file selected with `X = false`. Both path encodings in question worked when typed on a command line, so the target encoding was not the cause. macOS and Linux ignore `windowsHide`; every Explorer open and reveal on a Windows Host was affected. A WSL Host starts `explorer.exe` from a Linux process, where Node ignores the option.

## Decision

`NativeCommandRunner` takes an optional fourth argument, `NativeCommandOptions { windowsHide: boolean }`. `runNativeCommand` defaults it to `{ windowsHide: true }` in its signature, so every existing call keeps a hidden window. `runExplorer` passes `{ windowsHide: false }` and is the only caller that does; `wslpath`, `open`, `xdg-open`, `defaults`, PowerShell, and the picker commands still start hidden and open no console window.

The option travels through the same injected runner as the command, so the one `PathOpenerInternals.run` seam, and the open-in-app route that forwards it, observe the Explorer calls and their options unchanged.

## Alternatives considered

**A separate runner for Explorer.** Rejected. `runExplorer` would stop using the injected `run`, so tests and callers that inject a runner, including the open-in-app route, would no longer see the Explorer call, or the internals would need a second runner field.

**Choose the show state from the command name inside the runner.** Rejected. The runner would carry a list of GUI programs that no caller states, and a renamed or path-qualified Explorer would silently fall back to hidden.

**Start every command visible.** Rejected. Console tools such as `wslpath` and `powershell.exe` would flash a console window on every call.

## Testing

| Evidence | Behaviour |
|---|---|
| [runner.spec.ts](../../../../packages/util/native-command/tests/runner.spec.ts) | `execFile` receives `windowsHide: true` when a call passes no options or asks for a hidden window, and `false` when it asks for a visible one. |
| [path-opener.spec.ts](../../../../packages/util/native-command/tests/path-opener.spec.ts) | Every Explorer open and reveal, on Windows and from WSL, passes `{ windowsHide: false }`; `wslpath`, `open`, and `xdg-open` pass no options. Through the default runner, `execFile` starts Explorer visible and `wslpath` hidden. Restoring a hidden Explorer start fails these cases. |

## Consequences

- An Explorer open or reveal on Windows shows its window again, and the settings sheet, artifact, workspace, and open-in-app opens share that behavior.
- Explorer's exit code still does not prove that a window appeared; the handoff accepts 0 and 1 as before.
- Every other native command keeps its hidden start. A new caller that launches a GUI program through the runner has to pass `{ windowsHide: false }` itself.
- `openNativeFileApplication` on Windows still starts `powershell.exe` hidden and invokes the chosen handler from that process; whether the handler's window is affected has not been measured.
