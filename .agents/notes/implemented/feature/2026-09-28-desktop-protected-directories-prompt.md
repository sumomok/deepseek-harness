# Agent Note: The desktop system prompt tells the model to leave the app's own directories alone

Status: implemented

English | [中文](2026-09-28-desktop-protected-directories-prompt.zh.md)

## Problem

A customer asked the agent to move log files, and the commands it ran damaged the app's installation directory. Nothing in the desktop composition tells the model that the directory it runs from, or the data directory under `DSH_HOME` that holds sessions, settings, and profiles, belongs to the app. Under 完全权限 (`danger-full-access`) the file sandbox does not restrict anything, and under the walled modes an approved escalation lifts the wall for that call, so a model that has decided the move is part of the task meets no obstacle. The sandbox protection for these directories needs a core patch and comes later; until it lands, the model's own instructions are the only thing that applies in every mode.

## Decision

**One global system-prompt line.** The `desktop-brand` row in `apps/desktop-app/cordis.patch.yml` states `protectedDirsPrompt`, and the package's Host half (`apps/desktop-app/src/index.ts`) registers it through `ctx.inject(['systemPrompt'], …)` as the section `desktop:protected-directories`, literal text, at the `DEPLOYMENT_PERSONA_SUFFIX` order. The text is:

`Unless the user explicitly asks, do not modify, move, or delete this app's installation directory or its data directory (the path in the DSH_HOME environment variable), except its skills folder.`

**Placement.** Sections with equal order sort by name, and `desktop:…` follows `deployment:persona-suffix`, so the line is the last section of the system prompt. A preset's `dsh-persona` row shadows only the `deployment:persona-prefix` and `deployment:persona-suffix` sections in its own scope, and a delegated in-process child adds only its own prefix, so the global section stays in every `standard`, `ptc`, and `cordis` session and in their children. A persona with `complete: true` replaces the whole prompt; the `minimal` preset uses one, and its sessions do not carry the line.

**No core change.** The row, the plugin, and the text are the desktop's own composition layer. The system prompt reaches the session log as `system/message` (`packages/core/agent-loop/src/agent.ts`), so the line is recorded with every prompt that carries it, and replaying a session reconstructs it.

**The skills folder is exempt.** Agent-authored skills are written to `$DSH_HOME/skills`, and writing them is how the agent keeps what it learns across sessions, so the line names that folder as an exception. The user-global `$DSH_HOME/AGENTS.md` is not named; the sandbox protection decides which other paths under the data directory stay writable.

**Context cost.** The line is 30 words, about 40 tokens by a word-count estimate; the repository ships no tokenizer to measure it exactly. It is sent on every request of every desktop session. An existing session sees the new prompt once: the desktop's `deepseek-flash` row declares `systemPromptUpdate: in-history`, so the changed prompt is appended after the cached history rather than rewriting system node 0. The cost is justified because the line applies in 完全权限, where no sandbox rule does, and because under the walled modes a model that treats the directories as off limits does not request an escalation to touch them.

## Alternatives considered

**Put the line in the persona configuration.** `dsh-system-prompt`'s `personaSuffix` is the deployment slot, but each preset's `dsh-persona` row shadows it with its own suffix (`Your working directory is {{cwd}}.`), so a line placed there disappears from every preset session.

**Patch each preset's persona row.** Four rows would restate each preset's persona to add one sentence, and a preset added later, or edited in the Web preset editor, would not carry it.

**Write `$DSH_HOME` in the text.** The shorter draft named the data directory as `$DSH_HOME` without the skills exception, about 25 tokens. `$VAR` is bash syntax; the PowerShell tool on Windows describes the same variables as `$env:DSH_*` (`packages/shell/tool-pwsh/src/index.ts`). Naming the environment variable in prose reads the same under both shells.

**Name concrete paths.** The installation directory differs between a packaged app and a development launch, and between platforms; a path baked into the row would be wrong for some launches. The line names both directories without a path.

**Wait for the sandbox protection.** It needs a core patch across every platform's sandbox backend, and 完全权限 would still not be covered by it.

## Consequences

The line is advice, not enforcement: a model can still ignore it, and anything that bypasses the model's own decision (an explicit user request, a tool that runs outside the file sandbox) is unaffected. Subagents that run an external CLI (`subagent_codex`, `subagent_claude_code`) do not carry it.

**Known limitation: `minimal` sessions do not carry the line.** The `minimal` preset's persona is `complete: true`, which replaces the whole system prompt by design, and the desktop layer does not patch that preset. The sandbox protection covers those sessions when it lands. The installation directory has no environment variable, so the model knows it only from the process it runs in.

The skills exception keeps agent-authored skills writable without a user request. Other files under the data directory, the user-global `$DSH_HOME/AGENTS.md` included, fall under the line until the sandbox protection decides their status.

Changing the text is one row in `apps/desktop-app/cordis.patch.yml` and the constant the composition test compares it against.

## Testing

`apps/desktop-app/tests/protected-directories.spec.ts` mounts the Host half on a real prompt registry: the section is the last one, after the persona suffix, uninterpolated; disposal removes it; a missing, empty, or whitespace-only `protectedDirsPrompt` is refused. `apps/desktop-shell/tests/desktop-composition-layer.spec.ts` composes the real layers and renders the prompt from the composed rows: `standard`, `ptc`, and `cordis` sessions end with the line, a delegated child composed through `applyChildComposition` ends with it under its own persona, and a `minimal` session renders its complete persona alone. No keyless recorded-session snapshot runs the desktop profile, so no recorded session carries the line.
