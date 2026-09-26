# Agent Note: The desktop shell prepares settings.yaml for the server's one-time import

Status: implemented

English | [中文](2026-09-26-desktop-settings-yaml-pre-import.zh.md)

## Problem

Up to 0.1.0-rc.33 the desktop kept every live setting in `$DSH_HOME/settings.yaml`, one section per namespace. The 0.1.7 base removed that file: on its first start the server's `SettingsForms.importLegacyDocument` renames it to `settings.yaml.imported` and writes each section into the profile row whose id is the section name, through the same config editor the settings pages use. Nothing reads the renamed file again.

That import has two hard rules. A section with no row of that id fails. A section holding one key the row does not declare volatile fails whole, including a key the row's `Config` no longer has at all. A failed section is one warning on `ctx.logger`, which no exporter in the desktop composition writes anywhere a user or the shell can see, and its data stays in a file nothing reads.

An rc.33 client's file fails both rules in several places. `agent-presets` has no row of that id; the registry is `agent-preset-registry`, its choice is `selectedDefault`, the `code` preset is `ptc`, and rc.2 removed `modeSelectionEnabled`. `at-file` belonged to a plugin this release withdraws. The four plugin sections carry keys earlier plugin releases wrote and later ones dropped, gateway `mode` above all, and a hand edit can leave a value the plugin's schema refuses. `llm-deepseek.baseURL` holds a chat-completions address the Messages adapter cannot use. And the splash reads `ui-theme` from `settings.yaml` before any server exists, so after the rename it would fall back to the system theme.

## Decision

`apps/desktop-shell/src/settings-migration.ts` runs at launch right after `seedBuiltinBundles`, whose permission-row retirement it follows, and before the server spawns. It rewrites the file so every section either imports or is deliberately dropped with a record.

- **`agent-presets`** becomes an `agent-preset-registry: { selectedDefault }` section with `code` renamed `ptc`, and is left to the import. A client with `modeSelectionEnabled: false` gets no `selectedDefault`: its new sessions ran the deployment default, `standard`, and rc.2 has no switch to hide the choice again.
- **`ui-theme`** is written straight into the profile's `ui-theme` row, and the section is removed. `theme-preference.ts` reads that row first and `settings.yaml` only while the row is absent, which is the first launch after the upgrade.
- **`at-file`** maps onto the two rows that replaced it. `enabled: false` writes `ui-reference` with `disabled: true`. Exact names from its global ignore list, when that list differs from at-file's own default, are appended after the fifteen default names in `file-reference-local`'s `excludedDirectories`; names that are empty or contain a path separator are dropped, because that row's `validateConfig` throws on them. Regular expressions, case sensitivity, per-workspace lists, and `ignorePastedMentions` have no counterpart and are recorded. The section is then removed.
- **The four plugin sections** keep only each plugin's volatile keys, each with a value that plugin's schema accepts; everything else is dropped key by key, so one bad value no longer takes a whole price table or server list down with it. The allowed keys and value checks are the shell's own table; `tests/settings-migration-whitelist.spec.ts` holds it to the vendored packages.
- **`llm-deepseek.baseURL`** on host `api.deepseek.com`, whatever its path, is dropped, so the adapter's own Messages address applies. Any other host is kept and the user sees one dialog, over the loaded window, saying the address may need changing.
- **A duplicate gateway `- insert:` row** that the permission-row retirement kept because it had been edited is rewritten as an id-targeted row with the same config: the gateway's own bundle layer inserts that id, and a second insert of it keeps the gateway's settings page from mounting and makes `/review` fail. That row, and every id-targeted gateway row whose `config` mapping has no `alwaysAsk`, gets `GATEWAY_ALWAYS_ASK`, the desktop layer's map with `plugin_manager`, because the row's `config` replaces the desktop layer's; a spec case holds the constant equal to `apps/desktop-app/cordis.patch.yml`.

The shell writes a profile row directly only where the target row has no required field (`ui-theme`, `ui-reference`, `file-reference-local`), because an id-targeted row replaces the target's whole `config`. `agent-preset-registry` requires `default`, so its section goes through the import, which merges it over the composed config.

`settings.yaml` is read and written with `yaml` 2's `parseDocument`, `deleteIn`, and `toString`, the same library and YAML 1.2 core schema rc.33's settings file and the importer use, so an unquoted `prices.asOf: 2026-09-10`, numbers, booleans, and comments come back unchanged. The profile patch layer is edited the way the config editor edits it, with `!!js` scalars kept as tagged text.

`profiles/desktop-shell/settings-migration.json` records every dropped value with its reason, the rows written, the gateway row before and after, and the base URL decision. It is separate from `web-migration.json`, whose presence decides the web-profile sync's first run and whose fields `@haoran/dsh-plugin-updates` also reads. The run's first step, before anything else that can fail, moves `settings.yaml` to `settings.yaml.pre-rc34`; every rewrite is computed from that original and written back as `settings.yaml` last. The marker's `state` is `pending` from after the move until after the last change, then `done`, which makes every later launch skip the whole run except the two deferred parts below; a run that finds `pending` recomputes every rewrite from the original, and counts a row already written with the same fields as its own. When the marker is absent, `settings.yaml` and `settings.yaml.pre-rc34` are absent, and `settings.yaml.imported` exists, another profile's server imported the file first, and the shell copies it to `settings.yaml.pre-rc34` once so this profile imports it too. `settings.yaml`, the moved original, the copy taken from `settings.yaml.imported`, the marker, and the patch layer are written with mode 0600, because the settings hold MCP server environment and header values.

Four launch paths are handled explicitly. A run that throws after the move leaves `settings.yaml` absent, so that launch's server imports nothing and runs on the profile's rows and the shipped defaults; the next run finds `settings.yaml.pre-rc34` without `settings.yaml` and writes the migrated copy from it for the server to import. The server therefore never imports the rc.33 file as it stands, which matters because the importer merges each section into its row and a later import cannot take a value back out; an rc.33 `llm-deepseek.baseURL` on `api.deepseek.com` imported that way would send every DeepSeek request to the chat-completions address. Only a fault in the move itself leaves the file in place. A `settings.yaml` found while the marker is absent or cannot be read replaces any `settings.yaml.pre-rc34` an earlier run left, because the file in place is the one the server would import. The base URL notice is kept in the marker's `notices` until the window has shown it and the user has dismissed it, then `acknowledgeSettingsMigrationNotices` clears it, so a launch stopped by the mandatory-update gate or a failed server start shows it next time. A marker file that exists and cannot be read is not treated as absent: it may stand for a finished run, so nothing is copied back from `settings.yaml.imported`, and one log line names it. Under such a marker `settings.yaml.pre-rc34` is migrated, with its own log line, only when neither `settings.yaml` nor `settings.yaml.imported` is there: a finished run whose original parsed as a mapping leaves the migrated `settings.yaml`, which the server's import renames `settings.yaml.imported`, so that state is a run that stopped after the move and would otherwise leave the original unused. A finished run whose original did not parse leaves neither file, and running it again records the same skip. A marker path that is a directory reads as unreadable and makes the marker write throw, so each launch stops there until the directory is removed. The gateway step runs once `web-migration.json` records `permissionPatch`, or when there is no `web-migration.json`: only the web sync that writes that file copies the permission rows in, and the seeding earlier in the same launch retires them on every launch that finds no such file. A file without `permissionPatch`, readable or not, means the retirement stopped short; until it is recorded the marker carries `gatewayDeferred`, the rest of the run goes ahead, and the first later launch whose seeding recorded the retirement runs the step. Skipping the whole migration instead would let the server import the rc.33 file as it stands.

## Alternatives considered

**Leave every section to the importer.** It loses what the Problem lists: `agent-presets` and `at-file` have no row, and every plugin section that still carries a retired key fails whole.

**Write all four plugin sections as profile rows from the shell.** It needs the shell to restate each row's required ordinary fields, such as the gateway's `provider` and `model`, and to replicate the importer's merge. Stripping keys and letting the importer write the rows keeps one writer for those rows.

**Write `agent-preset-registry` as a row.** An id-targeted row replaces the whole `config`, and `default` is required and supplied only by the web-app bundle row, so a row with `selectedDefault` alone stops the registry from starting.

**Drop every `baseURL`.** It sends conversations for a user who configured a proxy to a service they did not choose. Keeping a non-DeepSeek host silently leaves requests failing with no explanation, which is why it is kept and reported.

**Record the migration in `web-migration.json`.** Creating that file changes the web-profile sync's first-run decision, and the sync rewrites it from its known fields on every launch, which would erase the new fields and make the S5 copy-back repeat.

**Parse with js-yaml.** Its default schema turns the unquoted `asOf` into a date and writes it back as a timestamp, which the balance plugin rejects; its failsafe schema turns numbers and booleans into strings, which the value checks would then strip.

## Consequences

An rc.33 client's gateway, auto-compact, MCP server, and balance settings, its default mode, its theme, and the @-reference switch survive the upgrade. What does not survive is listed, with values, in `settings-migration.json`.

Rows written by this migration or by the importer carry the whole config the row had at that moment, so a later bundle-layer default for those fields does not reach that user; this is the same limitation every settings-page save already has.

The value checks in `PLUGIN_SECTION_KEYS` are a copy of four plugins' schemas. The key sets are compared on every test run through the vendored packages' declaration files; the value verdicts are compared by loading the vendored host code, which only resolves after `pnpm run build`, and those cases report themselves skipped on an unbuilt tree.

The name list `file-reference-local` receives hides directories of those names, not files: nothing in the upstream @ references filters by file name.

## Related

- [The web profile's plugins stay synced to the desktop](2026-08-25-desktop-web-profile-migration.md) — owns `web-migration.json`, which this migration leaves alone.
- [The permission rows an old shell copied into the desktop profile are retired](../bug-fix/2026-09-17-retire-seeded-permission-patch-rows.md) — runs first; the gateway insert row it keeps is the one rewritten here.
