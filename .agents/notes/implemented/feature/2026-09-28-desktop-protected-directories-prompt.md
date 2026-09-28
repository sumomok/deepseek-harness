# Agent Note: The desktop system prompt tells the model to leave the app's own directories alone

Status: implemented

English | [中文](2026-09-28-desktop-protected-directories-prompt.zh.md)

## Problem

A customer asked the agent to move log files, and the commands it ran damaged the app's installation directory. Nothing in the desktop composition tells the model that the directory it runs from, or the data directory under `DSH_HOME` that holds sessions, settings, and profiles, belongs to the app. Under 完全权限 (`danger-full-access`) the file sandbox does not restrict anything, and under the walled modes an approved escalation lifts the wall for that call, so a model that has decided the move is part of the task meets no obstacle. The sandbox protection for these directories needs a core patch and comes later; until it lands, the model's own instructions are the only thing that applies in every mode.

## Decision

**One global system-prompt line that names the directories.** The `desktop-brand` row in `apps/desktop-app/cordis.patch.yml` states two templates, and the package's Host half (`apps/desktop-app/src/index.ts`) fills one of them at mount and registers the result through `ctx.inject(['systemPrompt'], …)` as the section `desktop:protected-directories`, literal text, at the `DEPLOYMENT_PERSONA_SUFFIX` order. The templates are:

- `protectedDirsPrompt`: `Unless the user explicitly asks, do not modify, move, or delete this app's installation directory ({installDir}) or its data directory ({dataDir}), except the skills folder {skillsDir}.`
- `protectedDirsPromptDataOnly`: `Unless the user explicitly asks, do not modify, move, or delete this app's data directory ({dataDir}), except the skills folder {skillsDir}.`

`{installDir}` is the row's `installDir`, which the row takes from `DSH_DESKTOP_INSTALL_DIR`, the variable the shell sets on the server of a packaged launch. A development launch sets none and gets the data-only template. `{dataDir}` is the harness home `resolveDshHome()` resolves, the resolver the server's own plugins use, and `{skillsDir}` is its `skills` folder, the root `@deepseek-ai/dsh-skill-filesystem` reads user skills from. Each path is inserted in backticks, so spaces and CJK characters in it stay unambiguous. Each template must contain exactly its placeholders; a missing or unknown one makes the row refuse to mount. On a Mac with the default home, the line reads: ``Unless the user explicitly asks, do not modify, move, or delete this app's installation directory (`/Applications/北冥.app`) or its data directory (`/Users/<user>/.dsh`), except the skills folder `/Users/<user>/.dsh/skills`.``

**Placement.** Sections with equal order sort by name, and `desktop:…` follows `deployment:persona-suffix`, so the line is the last section of the system prompt. A preset's `dsh-persona` row shadows only the `deployment:persona-prefix` and `deployment:persona-suffix` sections in its own scope, and a delegated in-process child adds only its own prefix, so the global section stays in every `standard`, `ptc`, and `cordis` session and in their children.

**The skills folder is exempt.** The user decided on 09-27 that agent-authored skills keep being written to the skills folder, because writing them is how the agent keeps what it learns across sessions. The user-global `AGENTS.md` in the data directory is not named; the sandbox protection decides which other paths under the data directory stay writable.

**No core change.** The row, the plugin, and the templates are the desktop's own composition layer. The system prompt reaches the session log as `system/message` (`packages/core/agent-loop/src/agent.ts`), so the line, with its concrete paths, is recorded with every prompt that carries it, and replaying a session reconstructs it.

**Context cost.** The filled line is about 40 words; with the macOS paths above it is roughly 60 tokens by a word and character estimate, more for longer or CJK-heavy paths. The repository ships no tokenizer to measure it exactly. It is sent on every request of every desktop session. The paths are stable for a machine, so the text, and the provider's prefix cache over it, stay the same from one request and one session to the next. An existing session sees the new prompt once: the desktop's `deepseek-flash` row declares `systemPromptUpdate: in-history`, so a changed prompt is appended after the cached history rather than rewriting system node 0. The cost is justified because the line applies in 完全权限, where no sandbox rule does, and because under the walled modes a model that treats the directories as off limits does not request an escalation to touch them.

## Alternatives considered

**Put the line in the persona configuration.** `dsh-system-prompt`'s `personaSuffix` is the deployment slot, but each preset's `dsh-persona` row shadows it with its own suffix (`Your working directory is {{cwd}}.`), so a line placed there disappears from every preset session.

**Patch each preset's persona row.** Four rows would restate each preset's persona to add one sentence, and a preset added later, or edited in the Web preset editor, would not carry it.

**Name the data directory by its environment variable.** An earlier draft said `(the path in the DSH_HOME environment variable)`, about 40 tokens, and left the installation directory unnamed. The model would have to run a command to learn either path before it could tell whether a command touches one; the user chose to name the resolved paths instead.

**Bake the paths into the row.** The installation directory differs between a packaged app and a development launch and between platforms, and the data directory follows `DSH_HOME`; the row states templates and the Host half resolves the paths at mount.

**Keep the template text in code.** A deployment-varying sentence in code is a hardcoded tunable; both templates live in the row, so the data-only wording is configurable too.

**Wait for the sandbox protection.** It needs a core patch across every platform's sandbox backend, and 完全权限 would still not be covered by it.

## Consequences

The line is advice, not enforcement: a model can still ignore it, and anything that bypasses the model's own decision (an explicit user request, a tool that runs outside the file sandbox) is unaffected. Subagents that run an external CLI (`subagent_codex`, `subagent_claude_code`) do not carry it.

**Known limitation: `minimal` sessions do not carry the line.** The `minimal` preset's persona is `complete: true`, which replaces the whole system prompt by design, and the desktop layer does not patch that preset. The sandbox protection covers those sessions when it lands.

**The paths are model-visible and logged.** Every desktop session log carries the installation directory, the data directory, and the skills folder in its `system/message` records. The data directory under the default home includes the account name; the model already sees paths under the same home through the session's working directory, so the line adds no new kind of fact to the log.

**A moved data directory changes the text once.** A new `DSH_HOME` takes effect on the next server start; the first request of each existing session then carries the changed prompt once, appended after its cached history. The same holds when an update moves the installation directory.

The skills exception keeps agent-authored skills writable without a user request. Other files under the data directory, the user-global `AGENTS.md` included, fall under the line until the sandbox protection decides their status.

Changing the wording is the two templates in `apps/desktop-app/cordis.patch.yml` and the constants the composition test compares them against.

## Testing

`apps/desktop-app/tests/protected-directories.spec.ts` mounts the Host half on a real prompt registry: with an installation directory the full template is filled and the section is the last one, after the persona suffix, uninterpolated; without one the data-only template is filled; paths with spaces and CJK characters and Windows paths are inserted verbatim in backticks; disposal removes the section; a template with a missing or unknown placeholder refuses to mount; a missing, empty, or whitespace-only template or an empty `installDir` is refused by the schema. The same file loads a skill from `<dataDir>/skills` through `@deepseek-ai/dsh-skill-filesystem`, so the exempt folder is the one skill loading reads. `apps/desktop-shell/tests/desktop-composition-layer.spec.ts` pins both templates and the `installDir` expression in the composed row, evaluates that expression with and without `DSH_DESKTOP_INSTALL_DIR`, and renders the prompt from the composed rows: `standard`, `ptc`, and `cordis` sessions end with the filled line, a delegated child composed through `applyChildComposition` ends with it under its own persona, and a `minimal` session renders its complete persona alone. No keyless recorded-session snapshot runs the desktop profile, so no recorded session carries the line.
