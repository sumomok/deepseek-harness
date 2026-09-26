# Agent Note: The desktop shell records a migrated plugin the running server did not load

Status: implemented

English | [中文](2026-09-26-desktop-load-failure-from-running-output.zh.md)

## Problem

[The web-profile sync](2026-08-25-desktop-web-profile-migration.md) disables a migrated plugin the server's loader refused at import time. It found one by catching `ServerExitedBeforeUrl` and scanning that boot's output for the loader's `failed to import loader entry <id> (<module>)` line, then retrying the boot once without the plugin.

On the 0.1.7 base neither half of that happens. The line no longer exists: upstream reverted the transactional Cordis loader that printed it, and a failed import of an optional entry is now `ctx.logger.error` followed by a row of the startup audit block, `<id> (<name>): failed to import`. The server does not exit either: the audit block is a warning for every entry outside a fixed set of required upstream ids, and a migrated plugin is never in that set, so the URL line prints, `startServer` resolves, and the catch never runs. The compatibility check added in the same base behaves the same way: it writes `skipping profile bundle "<name>"` or `disabling profile plugin row "<id>"` to stderr and the boot continues. A broken or refused migrated plugin is therefore absent on every launch with nothing on screen, which is the silent disappearance the sync was built to prevent.

## Decision

`startServer` takes an optional per-line callback and feeds it every line of stdout and of stderr, each stream split on its own, for as long as the process writes, the lines after the URL line included. The URL line reaches stdout from the web app's own continuation and the audit block reaches stderr from app-boot's, so neither order can be assumed.

`startServerWithQuarantine` passes each line to `quarantineLoadFailureFromOutput`, which recognizes three lines:

- a row of the audit block, `<id> (<name>): failed to import`, where `<name>` is a package name or, for an inserted relative path, a `file:` URL whose package is the directory after its last `node_modules`;
- `<bin>: skipping profile bundle "<package>": <reason>`;
- `<bin>: disabling profile plugin row "<id>": <reason>`, whose id is looked up in each migrated package's own bundle layer, or `<bin>: disabling profile plugin <module URL>: <reason>` for a row without an id.

A package the marker lists in `migrated` moves to `defective` with kind `load-failed` and out of `dsh.profile.bundles`. The server is not restarted: this boot already runs without the plugin, and the next one does not load it. A recorded name is no longer in `migrated`, which is what records it once. The detail of an import failure is `failed to import` and nothing more, because the import error itself reaches only the server's logger, which writes nowhere the shell reads; the other two lines carry their own reason.

The retry after `ServerExitedBeforeUrl` stays, for a boot that exits before its URL line after a line blamed a migrated plugin, or whose whole output does. On the 0.1.7 base no migrated plugin causes that exit, so the path is kept for a base that exits on an optional import failure again; it no longer recognizes the removed loader line, and it does not read the multi-line required-entry diagnostic, because quarantining a migrated plugin cannot repair a required entry.

## Alternatives considered

**Keep scanning only the output of a boot that exits before its URL line.** It never runs on this base, which is the problem.

**Scan only until the URL line.** The audit block and the URL line are written by two continuations that do not wait for each other, on two pipes, so the block can arrive after the URL line.

**Restart the server after recording a name.** The server is already running correctly without the plugin; a restart costs a second boot and changes nothing the user sees, since the next launch skips the name anyway.

**Leave the refused plugin a known limitation.** A plugin that disappears with nothing in the settings page to say why is the outcome the `defective` list exists to prevent.

## Consequences

A migrated plugin that fails to import, or that the compatibility check refuses, appears in the plugin-updates page's disabled group from the launch after the one that found it, with the repair routes the web-profile sync already provides.

The shell depends on the exact text of three upstream lines. A base that rewords one of them brings back the silent absence for that case, and `tests/profile-seed.spec.ts` holds the three shapes this shell reads.

`defective` cannot say why an import failed; the user or the repair routes find that in the server log.

## Testing

`apps/desktop-shell/tests/profile-seed.spec.ts` feeds `quarantineLoadFailureFromOutput` an audit block naming a package and one naming a `file:` URL, a skipped bundle, a row disabled by id and one disabled by module URL, a whole output that blames two packages and one of them twice, and lines that name nothing it migrated. `apps/desktop-shell/tests/server.spec.ts` runs a scripted child that prints the URL line and then, on stderr, the audit block, and checks that the name reaches `defective` while the child is spawned once. The packaged-app check, a broken plugin in a real `web` profile, is the F8 smoke step.

## Related

- [The web profile's plugins stay synced to the desktop, and a defective one stays visible](2026-08-25-desktop-web-profile-migration.md) — owns the sync and the `defective` list; its quarantine-and-retry paragraph describes the base before 0.1.7, and this note replaces it.
