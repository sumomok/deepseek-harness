# Agent Note: The desktop names its data directory with a pointer, a marker, and a link

Status: implemented

English | [中文](2026-09-27-desktop-data-location-pointer.zh.md)

## Problem

A person asked to keep the desktop's data on another disk. Every server path is derived at load time from `DSH_HOME` through `dshHomePath()` and `resolveDshHome()`, and the server child inherits the shell's environment, so exporting one value before the spawn relocates the whole server without a core patch. What the shell lacked was a durable record of where the data is, a way to tell that record from a folder that only sits at the same path, and an answer for the two other readers of the home: a terminal `dsh` that has no `DSH_HOME` and reads `~/.dsh`, and a `DSH_HOME` the person sets themselves.

This change settles those three. Moving the data — copy, verification, deleting the old directory, and the progress window — is left for a later change.

## Decision

**A pointer in userData and a marker in the data directory vouch for each other.** `apps/desktop-shell/src/data-location.ts` keeps `data-location.json` under Electron's user-data directory, with `version`, `path`, `dataId`, `lastSeenEnv`, and `movedAt`, written through a flushed temporary file with the previous copy kept as `data-location.json.bak`. `.dsh-data-id` inside the data directory holds the same UUID. The pointer is its own file rather than a field of `desktop-state.json`, because that file's contract is that a missing or unreadable copy changes nothing, and the pointer is a precondition of the launch. userData survives updates and, on Windows, uninstalls, since `deleteAppDataOnUninstall` is off.

**Without a pointer the launch is unchanged, and a missing directory never falls back.** No pointer resolves the home as every earlier build did — a non-blank process `DSH_HOME`, otherwise `~/.dsh` — and the only write is a marker added to an existing home, so a later move can recognize it. A pointer whose directory is missing, or carries another identity or none, holds the launch on the boot page with 重试, 选择数据所在的文件夹…, and 退出; a picked folder is accepted only with the pointer's identity. Falling back to `~/.dsh` would show an empty home as if the data were lost, and the two directories would drift apart after it.

**A newer `DSH_HOME` overrides the pointer.** The release owner first decided that the pointer wins and a conflicting variable is only reported, then replaced that rule on 2026-09-27 with "the newer value wins". Each launch with a pointer reads `DSH_HOME` — the process environment first, excluding the value the shell exported itself (`DSH_DESKTOP_POINTER_HOME` marks it), then the macOS login shell through `$SHELL -ilc` with random markers and a five-second limit, or the Windows user environment through PowerShell — and compares it with `lastSeenEnv`. A different value is followed when its directory carries a marker or holds `sessions/`, `profiles/`, `attachments/`, or `storages/`; otherwise the boot window asks between 使用这个新位置 and 保持原位置, and the declined or adopted value becomes `lastSeenEnv`, so it does not ask again. A value that cannot be read leaves `lastSeenEnv` alone, because a failed probe is not evidence that the variable was removed. The probe runs only when a pointer exists, so an installation that never moved pays no shell start.

**Writing `DSH_HOME` touches one store per platform, and never a line the person wrote.** `apps/desktop-shell/src/terminal-env.ts` sets the Windows user variable through `[Environment]::SetEnvironmentVariable(..., 'User')`, which broadcasts `WM_SETTINGCHANGE`, with the value in the child's environment rather than on the command line; `reg query` is not parsed because its output is in the OEM code page. On macOS it owns one block between `# >>> DSH data location >>>` and `# <<< DSH data location <<<` in `~/.zshrc`, `$ZDOTDIR/.zshrc`, or `~/.bash_profile`, backs the file up, and replaces it atomically at its link target. A `DSH_HOME` assignment outside the block stops the write and is logged with its line: appending the block after it would silently override the person's line, and editing it would change a file region the shell does not own. fish and other shells are not written. `launchctl setenv` is not used, because its value outlives a removed block until reboot and would keep feeding the old location to every app opened from Finder. A folder picked on the boot page is written this way; a declined `DSH_HOME` is not rewritten.

**`~/.dsh` is kept as a link to the data directory.** The release owner required that a terminal `dsh` see the same data after a move. `apps/desktop-shell/src/home-link.ts` makes `~/.dsh` a symbolic link, a junction on Windows, whenever the pointer names another directory and `~/.dsh` is absent or a link elsewhere; an old link is removed with `unlink` and never followed. A real directory or file there is left as it is and logged, told apart by whether it carries this data's marker, because replacing it would mean deleting it. The upstream CLI was probed on macOS with a temporary `HOME` whose `~/.dsh` dangled, with writes outside that directory denied by `sandbox-exec`: `--profile headless`, `plugin list`, and `dump-config` each failed with `ENOENT` at the first `mkdirSync` under the home and created nothing at the link or its target, so a dangling link needs no core patch.

## Alternatives considered

**Leave no link and document that a terminal `dsh` sees a new empty `~/.dsh`.** Rejected by the release owner: the CLI must see the same data.

**Let the pointer win over any `DSH_HOME`.** Replaced by the release owner's later rule: a value the person set after the pointer was written is the newer decision.

**Fall back to `~/.dsh` when the data directory is missing.** Rejected: an empty home reads as lost data, and both copies then change independently.

**Probe the login shell on every launch.** Rejected: it adds a shell start to every launch of an installation that never moved its data, and changes nothing for it.

## Consequences

The data-location prompts are message boxes over the boot page, because that page is a `data:` document without preload or IPC. `settleDataLocation` returns what the launch settled — the home, the explicit value and its source, and the link outcome — for the settings entry that a later change adds.

A terminal that exported `DSH_HOME` before the location changed keeps the old value until it is reopened, and an app launched from it takes that value for a newer one. `$ZDOTDIR` is honoured only when the app's own environment carries it.

The Windows paths are covered by recorded stand-ins only: the junction calls, the PowerShell scripts and their UTF-8 output, `WM_SETTINGCHANGE` reaching Explorer, and how a Windows CLI reports a dangling junction are known only on a real Windows machine.

## Related

[Settings import before rc.34](2026-09-26-desktop-settings-yaml-pre-import.md) is the other launch step that runs before the server reads the home.
