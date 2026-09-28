# Agent Note: The desktop system prompt tells the model to leave the app's own directories alone

Status: implemented

English | [中文](2026-09-28-desktop-protected-directories-prompt.zh.md)

## Problem

A customer asked the agent to move the app's log files, and the commands it ran damaged the app's installation directory. Nothing in the desktop composition told the model which directories belong to the app: the installation directory it runs from, the harness data directory under `DSH_HOME` that holds sessions, settings, and profiles, and the desktop shell's own folders for preferences, logs, and downloaded updates. On macOS the logs are not even under the shell's `userData` folder but under `~/Library/Logs`. Under 完全权限 (`danger-full-access`) the file sandbox does not restrict anything, and under the walled modes an approved escalation lifts the wall for that call, so a model that has decided the move is part of the task meets no obstacle. The sandbox protection for these directories needs a core patch and comes later; until it lands, the model's own instructions are the only thing that applies in every mode.

## Decision

**One global system-prompt line that names the directories.** The `desktop-brand` row in `apps/desktop-app/cordis.patch.yml` states the line, one clause per directory, and the list separators; the package's Host half (`apps/desktop-app/src/index.ts`) fills them at mount and registers the result through `ctx.inject(['systemPrompt'], …)` as the section `desktop:protected-directories`, literal text, at the `DEPLOYMENT_PERSONA_SUFFIX` order. The row states:

- `protectedDirsPrompt`: `Unless the user explicitly asks, do not modify, move, or delete this app's own directories: {directories}. The skills folder {skillsDir} is exempt.`
- `directoryClauses`: `the installation directory ({installDir})`, `the data directory ({dataDir})`, `the settings folder ({appDataDir})`, `the logs folder ({logDir})`, `the update download folder ({updateCacheDir})`.
- `directorySeparator` `, ` and `directoryLastSeparator` ` and `.

**Where each path comes from.** `{dataDir}` is the harness home `resolveDshHome()` resolves, the resolver the server's own plugins use, and is always listed; `{skillsDir}` is its `skills` folder, the root `@deepseek-ai/dsh-skill-filesystem` reads user skills from. The other four come from variables the desktop shell sets on the server child alone, read by `!!js process.env…` in the row: `DSH_DESKTOP_INSTALL_DIR` for a packaged launch (`apps/desktop-shell/src/install-dir.ts`), and on every shell launch `DSH_DESKTOP_USER_DATA_DIR` (Electron's `userData`), `DSH_DESKTOP_LOG_DIR` (the directory `dsh-server.log` is written to), and `DSH_DESKTOP_UPDATE_CACHE_DIR` (electron-updater's cache) from `apps/desktop-shell/src/app-dirs.ts`. A clause is listed only when its path is set, so a development launch of the shell lists no installation directory and `dsh --profile desktop-shell` started by hand lists the data directory alone, without a template per combination. Each path is inserted in backticks, so spaces and CJK characters in it stay unambiguous, and an inserted path is never scanned for placeholders again. The line must contain exactly `{directories}` and `{skillsDir}` and each clause exactly its own placeholder; otherwise the row refuses to mount. A packaged launch on a Mac with the default home reads: ``Unless the user explicitly asks, do not modify, move, or delete this app's own directories: the installation directory (`/Applications/北冥.app`), the data directory (`/Users/<user>/.dsh`), the settings folder (`/Users/<user>/Library/Application Support/@deepseek-ai/dsh-desktop`), the logs folder (`/Users/<user>/Library/Logs/@deepseek-ai/dsh-desktop`) and the update download folder (`/Users/<user>/Library/Caches/<updater cache>`). The skills folder `/Users/<user>/.dsh/skills` is exempt.``

**Placement.** Sections with equal order sort by name, and `desktop:…` follows `deployment:persona-suffix`, so the line is the last section of the system prompt. A preset's `dsh-persona` row shadows only the `deployment:persona-prefix` and `deployment:persona-suffix` sections in its own scope, and a delegated in-process child adds only its own prefix, so the global section stays in every `standard`, `ptc`, and `cordis` session and in their children.

**The skills folder is exempt.** The user decided on 09-27 that agent-authored skills keep being written to the skills folder, because writing them is how the agent keeps what it learns across sessions. The user-global `AGENTS.md` in the data directory is not named; the sandbox protection decides which other paths under the data directory stay writable.

**No core change.** The row, the plugin, the templates, and the shell's variables are the desktop's own code and composition. The system prompt reaches the session log as `system/message` (`packages/core/agent-loop/src/agent.ts`), so the line, with its concrete paths, is recorded with every prompt that carries it, and replaying a session reconstructs it.

**Context cost.** The macOS line above is about 60 words and 470 characters; long paths split into many tokens, so it is roughly 110 to 130 tokens by a word and character estimate, more for longer or CJK-heavy paths. The repository ships no tokenizer to measure it exactly. It is sent on every request of every desktop session. The paths are stable for a machine, so the text, and the provider's prefix cache over it, stay the same from one request and one session to the next. An existing session sees the new prompt once: the desktop's `deepseek-flash` row declares `systemPromptUpdate: in-history`, so a changed prompt is appended after the cached history rather than rewriting system node 0. The cost is justified because the line applies in 完全权限, where no sandbox rule does, because the incident it answers was a move of the logs, and because under the walled modes a model that treats the directories as off limits does not request an escalation to touch them.

## Alternatives considered

**Put the line in the persona configuration.** `dsh-system-prompt`'s `personaSuffix` is the deployment slot, but each preset's `dsh-persona` row shadows it with its own suffix (`Your working directory is {{cwd}}.`), so a line placed there disappears from every preset session.

**Patch each preset's persona row.** Four rows would restate each preset's persona to add one sentence, and a preset added later, or edited in the Web preset editor, would not carry it.

**Name the data directory by its environment variable.** An earlier draft said `(the path in the DSH_HOME environment variable)`, about 40 tokens, and named no path. The model would have to run a command to learn a path before it could tell whether a command touches it; the user chose to name the resolved paths instead.

**Name only `userData` as the settings and logs folder.** On macOS the logs are under `~/Library/Logs`, not `userData`, so that line would not have named the folder the incident moved.

**One template per combination of known directories.** Installation directory, shell directories, and neither already make three templates, and each added directory doubles them; one line template with a clause per directory covers every launch.

**Bake the paths into the row, or keep the copy in code.** The paths differ by platform, by launch, and with `DSH_HOME`, so the row states templates and the Host half resolves paths at mount. A deployment-varying sentence in code is a hardcoded tunable, so every clause and separator lives in the row.

**Wait for the sandbox protection.** It needs a core patch across every platform's sandbox backend, and 完全权限 would still not be covered by it.

## Consequences

The line is advice, not enforcement: a model can still ignore it, and anything that bypasses the model's own decision (an explicit user request, a tool that runs outside the file sandbox) is unaffected. Subagents that run an external CLI (`subagent_codex`, `subagent_claude_code`) do not carry it.

**Known limitation: `minimal` sessions do not carry the line.** The `minimal` preset's persona is `complete: true`, which replaces the whole system prompt by design, and the desktop layer does not patch that preset. The sandbox protection covers those sessions when it lands.

**The paths are model-visible and logged.** Every desktop session log carries the listed directories in its `system/message` records. Paths under the default home include the account name; the model already sees paths under the same home through the session's working directory, so the line adds no new kind of fact to the log.

**A moved directory changes the text once.** A new `DSH_HOME`, or an update that moves the installation directory, takes effect on the next server start; the first request of each existing session then carries the changed prompt once, appended after its cached history.

**On Windows and Linux the logs folder is listed inside the settings folder.** The shell's logs sit under `userData` there, so the line names a folder and one of its subfolders; the clause stays because on macOS it names a separate folder, and the explicit logs folder is what the incident touched.

The skills exception keeps agent-authored skills writable without a user request. Other files under the data directory, the user-global `AGENTS.md` included, fall under the line until the sandbox protection decides their status.

A layer that patches the `desktop-brand` row by id replaces its whole `config` and must restate every key, or the row refuses to mount and the line is gone. Changing the wording is the templates in `apps/desktop-app/cordis.patch.yml` and the constants the composition test compares them against.

## Testing

`apps/desktop-app/tests/protected-directories.spec.ts` mounts the Host half on a real prompt registry: a packaged launch lists all five directories after the persona suffix, uninterpolated; a development launch of the shell leaves out the installation directory; without the shell's variables only the data directory is listed; two clauses join with the last separator alone; paths with spaces and CJK characters and Windows paths are inserted verbatim in backticks, and a path containing a placeholder is not rescanned; disposal removes the section; a line or clause with a missing or unknown placeholder refuses to mount; a missing or blank template, a missing clause, or an empty path is refused by the schema. The same file loads a skill from `<dataDir>/skills` through `@deepseek-ai/dsh-skill-filesystem`, so the exempt folder is the one skill loading reads. `apps/desktop-shell/tests/app-dirs.spec.ts` pins the three shell variables, that an empty path sets none, and that `main.ts` takes them from Electron's `userData`, the log directory, and `updaterCacheDir()`, logs each, and adds them to the server's environment. `apps/desktop-shell/tests/desktop-composition-layer.spec.ts` pins every template and each `!!js` expression in the composed row, evaluates each expression with and without its variable, and renders the prompt from the composed rows: `standard`, `ptc`, and `cordis` sessions end with the filled line, a delegated child composed through `applyChildComposition` ends with it under its own persona, and a `minimal` session renders its complete persona alone. No keyless recorded-session snapshot runs the desktop profile, so no recorded session carries the line.
