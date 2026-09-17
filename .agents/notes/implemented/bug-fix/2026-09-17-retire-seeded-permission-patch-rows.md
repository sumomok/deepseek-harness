# Agent Note: The permission rows an old shell copied into the desktop profile are retired

Status: implemented

English | [中文](2026-09-17-retire-seeded-permission-patch-rows.zh.md)

## Problem

A desktop client running 0.1.0-rc.33 still offers the access modes of 2026-08: 仅可查看 / 工作区内修改 / 完全权限 / 自动审查, in that order, with `yolo-access` described as 沙箱完全关闭，文件系统与命令不再有操作系统层面的围墙…… `@haoran/dsh-llm-permission-gateway` 0.4.3 declares four rows in another order — walls, then no walls but still asked, then no walls and never asked — and its own name and description on the reviewed one. None of that reaches the machine.

The shadowing file is `~/.dsh/profiles/desktop-shell/cordis.patch.yml`, last written 2026-08-27, and it holds a `- id: permission` entry carrying the whole preset table plus a `llm-permission-gateway` row. A profile's own patch layer is the last layer but one — every bundle layer applies before it — so an id-targeted entry there replaces the row's whole `config` and the plugin's table never takes effect. Nothing in the product takes a row back out of that file: `WITHDRAWN_WEB_BUNDLES` and `web-migration.json` reach bundle names and links, never the patch layer's contents.

The rows are the shell's own leavings, by the route [`copyPristineProfileFile`](../../../../apps/desktop-shell/src/profile-seed.ts) describes. The first sync a `desktop-shell` profile ever runs replaces its still-pristine patch template with the `web` profile's file verbatim, and on this machine the `web` layer was the hand-written one the [2026-08-22 gateway note](../feature/2026-08-22-desktop-builtin-permission-gateway.md) records: `yolo-access` and the gate paired by a comment asking a reader not to separate two blocks. 0.1.0-rc.21 moved both rows into the package (`1229bc8049`, `apps/desktop-server/vendor/haoran-dsh-llm-permission-gateway-0.1.3.tgz`), and six days later the first sync copied the machine's own copy of them into the profile that now shadows the package.

The exact bytes of that machine's file are not in this repository. `git log -S 'only defensible while' --all` matches nothing here, and `git log -S 'yolo-access' -- apps/` matches only the three vendored tarballs; the shell's own `PROFILE_PATCH_TEMPLATE` has always been the empty `[]` layer. What is recoverable is the 0.1.3 patch layer, whose two entries are field for field what the hand-written pairing declared, and the machine's own header comment paraphrases that file's own.

## Decision

`retireSeededPermissionRows` in `apps/desktop-shell/src/profile-seed.ts` runs once per profile, after `syncWebBundles` so a copy made this launch is retired on the same launch. It reads the profile's patch layer, takes out each entry that is still exactly one of the two rows the 0.1.3 layer declared, and writes the rest back.

Matching is by content, not by file bytes: a recognizer reads one top-level entry as mappings, sequences, and plain or simply quoted scalars, and refuses everything whose meaning needs the loader's own YAML schema — a tag, a block scalar, flow syntax, a duplicate key, a tab. What it reads is serialized with every mapping's keys sorted and compared against the two rows, so the same fields with the same values match whatever order they were written in. Order is not part of a copied row's identity — taking the row out is what puts the shipped preset order back.

A removal takes the entry, the comment run written directly above it, and the blank lines directly below it. Everything else in the file — other entries, `!!js` expressions, the owner's own prose — stays byte for byte where it was. A layer holding nothing else becomes the empty template again; one left holding only comments gains the `[]` those comments annotated, because the loader reads this file as a top-level array.

A row that differs anywhere is its owner's and stays, with the reason in the log: `skipped cordis.patch.yml: the permission preset table is not the one this shell wrote; left exactly as it is`. The judge route on the gateway row counts — a `model` someone changed makes that row theirs. A removal prints `retired the permission preset table from cordis.patch.yml`, from the new `SeedReport.retired`.

The decision is recorded as `permissionPatch` in `web-migration.json` — `removed`, `kept`, or `absent` — and its presence is what stops a later launch reading the file. A profile with no marker at all gains none here: the marker's existence is what `syncWebBundles` reads as "this profile has synced before", and creating one would suppress the one-time copy of the web profile's own two files. Such a profile is read again next launch, which costs one file read and one comparison against the template, and a patch layer still holding that template is never parsed at all.

## Alternatives considered

**Merge the plugin's table into the profile's layer instead of removing the entry.** It would keep whatever else the entry carries. It also means parsing a patch layer to combine it with another, which is a second implementation of the loader's own YAML schema — the reason `copyPristineProfileFile` copies a file rather than merging it, stated there since that function was written. The recognizer here reads only well enough to identify this shell's own leavings and refuses everything else, which is a much smaller promise.

**Match the whole file against a shipped template, byte for byte.** It is the strictest possible rule and needs no recognizer. It would never fire: the bytes on the machine came from a hand-written `web` layer whose comment wording differs from the package's, and this repository has never held them. A rule that cannot match the one case it exists for is not a conservative rule.

**Stop the first sync from copying the `web` patch layer.** It prevents the next machine from acquiring these rows. It repairs no machine that already has them, and it gives up the copy's whole purpose, which is carrying the owner's own rows across with their plugins.

**Rename the preset id in the plugin so a stale copy cannot target it.** A copy keyed on `yolo-access` would stop shadowing a row named something else. `permission.defaultPreset` is stored under a closed union over this table's names and `SettingsProvider.register` rejects a stored section the schema no longer admits, so the rename makes the whole `permission` settings section fail to install for anyone who stored it — the reason the [四档访问方式 note](../feature/2026-09-17-gateway-four-access-modes.md) keeps the id.

**Remove the gateway row whatever its `config` says.** The row's identity is the plugin name, and the bundle layer declares the row anyway, so the profile's copy adds nothing but a duplicate. `provider` and `model` there are a judge route someone may have chosen deliberately, and this shell has no way to tell a route from a leftover. Leaving an edited row costs a log line; taking one out costs a setting nobody asked to lose.

**Create the marker for a profile that has never synced.** It would stop the per-launch re-read for a hand-edited layer that keeps a row. The marker's existence is a flag `syncWebBundles` already reads, and writing one early suppresses the one-time copy of `cordis.patch.yml` and `pnpm-workspace.yaml` for that profile. The re-read is a `readFileSync` and a string comparison.

## Consequences

A client that copied those rows over gets the shipped access-mode table back on its next launch, with no terminal and no hand-edited YAML, and keeps every other row in its patch layer. A client that edited either row keeps it and is told which one and why, once per launch until a marker exists to record the decision.

`MigrationMarker` gains an optional field. It is a cross-component contract `@haoran/dsh-plugin-updates` reads, so the field is additive, absent until decided, and carried through by both `readMigrationMarker` and the marker `syncWebBundles` writes.

The recognizer is the shell's, not the loader's: an entry it refuses is left alone, which is the safe direction but means a machine whose copy uses a tag or an unusual quoting keeps the shadow and says so in the log rather than being repaired.

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` drives every case through `seedBuiltinBundles`, with the two rows staged verbatim from the 0.1.3 patch layer: both removed with the owner's own row and comment intact; the empty template restored when they were the whole file; a `[]` appended when only prose is left; an edited table kept with its skip line while the gateway row beside it still goes; a table whose fields were written in another order still matched; an edited judge route kept; a `!!js/eval` route kept; a marker that already carries a decision read and obeyed with the rows still in the file; a profile with no marker retired without gaining one; and a patch layer still holding the template never read.
