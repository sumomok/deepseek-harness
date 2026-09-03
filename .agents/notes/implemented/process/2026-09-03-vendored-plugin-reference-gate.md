# Agent Note: Vendored plugin reference gate

Status: implemented

English | [中文](2026-09-03-vendored-plugin-reference-gate.zh.md)

## Problem

The desktop's built-in plugins are declared once, as `file:./vendor/<flattened-name>-<version>.tgz` dependencies of [`apps/desktop-server/package.json`](../../../../apps/desktop-server/package.json), and restated in two places nothing regenerates: the `OVERRIDES` table in [`scripts/gen-third-party-notices.ts`](../../../../scripts/gen-third-party-notices.ts), whose vendor paths become attribution links in `THIRD_PARTY_NOTICES.md`, and the built-in plugins table in [`apps/desktop/README.md`](../../../../apps/desktop/README.md) and its Chinese counterpart.

Re-vendoring a plugin commits a new tarball, deletes the old one, and repoints the specifier. Both restatements are left behind, and both had drifted: seven of the eleven rows in the built-in plugins table named a version older than the tarball beside them — `@haoran/dsh-clickable-refs` at `0.3.3` against a committed `0.4.1`, `dsh-better-sidebar` at `0.15.2` and still described as installed from npm, `dsh-at-file` at `v0.6.5` and still described as a commit in the author's repository — while two `OVERRIDES` entries named tarball filenames that no longer exist, so `THIRD_PARTY_NOTICES.md` carried two dead links to the archives it exists to attribute. Nothing failed, because nothing checked.

## Decision

[`scripts/verify-vendored-plugin-versions.ts`](../../../../scripts/verify-vendored-plugin-versions.ts) makes the desktop-server manifest the single source of record and checks every restatement against it. It runs as the `vendored-plugin-versions` leaf of `doc-sync` (and of the build-free `doc-quick` aggregate), beside the other `verify-*` documentation gates.

The tarball filename is the contract, not the `version` field inside the archive. `dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz` and `dsh-at-file-0.7.0-da602d1.tgz` both hold a manifest declaring a plain upstream version; the suffix is what distinguishes the bytes this repository ships from the upstream release of the same number, and it is what a reader needs in order to find the file. The gate derives each version by stripping the `pnpm pack` name prefix (`@haoran/dsh-clickable-refs` → `haoran-dsh-clickable-refs-`) from the filename, and refuses a specifier whose filename does not carry its own package name, because no version can be read out of one.

The assertions that follow: every `file:` specifier names a tarball under `./vendor/` that exists; every `OVERRIDES` entry whose `repo` is a vendor tarball path names one that exists; each table holds exactly one row per vendored package and no row for anything else, so a withdrawn plugin cannot leave an orphan row behind; and each row's version cell equals the version code span followed by that document's provenance phrase, so a row cannot go back to claiming npm or a Git tag while its version stays right. Rows are matched by package name, so reordering them or editing a description does not disturb the gate.

The rules are pure functions over the manifest text, the README text, the override table, and an existence probe supplied by the caller, so [the spec](../../../../scripts/verify-vendored-plugin-versions.spec.ts) pins each rejection against fixtures without a filesystem. `OVERRIDES` is exported from the notices generator for this, rather than re-declared: a second copy of those paths is the drift this gate exists to stop.

Both README tables are read, each with its own section heading and its own provenance phrase. The pairing gate is not a substitute for the second read: its structural signature counts a table's rows and columns, not the text inside a cell, so a version edited on the Chinese side alone and re-recorded passes it green.

## Alternatives considered

**Generate the README table from the manifest.** The version column is derivable, but the description column beside it is hand-written product prose in two languages, and the table sits inside a section of surrounding prose. Generating one column of a document that is otherwise authored costs a generator, a fence protocol, and a translation exemption to replace a check that fits in one file.

**Assert inside [`scripts/gen-third-party-notices.spec.ts`](../../../../scripts/gen-third-party-notices.spec.ts)**, the way the notices file's own freshness is asserted, at no new scheduler slot. That spec owns disclosure content; README rows and manifest specifiers are neither. Worse, the failure would surface in the test lane rather than in `doc-sync`, which is the aggregate a documentation change actually runs.

**Read the version from `package.json` inside each tarball.** It disagrees with the filename for exactly the two packages whose provenance most needs stating — a patched release and an unreleased commit — and would force the README to name a version that matches no file in `vendor/`. Extracting eleven archives per gate run to learn less than the filename already says is the wrong trade.

**Also reject a tarball in `vendor/` that no specifier names.** A real drift class, but a separate one, and it rejects the legitimate intermediate state of a re-vendoring that stages the new archive before repointing the manifest. Every assertion here reads the manifest as the source of record; that one would make the directory listing a second one.

## Consequences

Re-vendoring a plugin now carries both README tables — and, when the tarball's name changes, the notices override — along with it, or `doc-sync` fails with a line naming the document, the package, and the tarball that contradicts it. The check is text-only — no install, no extraction — so it costs milliseconds and is in the quick aggregate.

The version this table names is not the version the application reports. `-patched1` and `-da602d1` exist only in the filename; the manifest inside each archive says `0.18.0-alpha.0` and `0.7.0`, and that is what installs and what the Updates tab `@haoran/dsh-plugin-updates` renders shows. Naming the archive is what lets a reader find the exact bytes shipped, and this divergence is what it costs.

Only the tables are gated. The prose around them still carries counts and version literals no parser sees — how many plugins ship, how many have a browser half and which ones they are, the sidebar's `0.14.0` floor, and the version quoted in the shadowing warning — so changing `Nine of the eleven` to `Three` leaves the gate green. Those were checked by hand in this change.

`OVERRIDES` is now part of the notices generator's module interface. A change to its shape reaches this gate, which is the intended coupling: the two files are describing the same tarballs.

The gate reads each table by its own section heading and the `` | `name` | `version` `` row grammar. Restructuring either section fails the gate loudly rather than silently passing, since an unreadable table is itself a violation.

## Related

[The desktop installer ships plugins and seeds them into a profile of its own](../feature/2026-08-21-desktop-builtin-plugins.md) owns why the built-ins are in the payload and what a profile's own copy of one does; [taking the vendored plugins off the retired client runtime](2026-09-01-desktop-server-vendored-plugins-off-client-runtime.md) owns the pass that gave most of them their current archives. Neither is parsed by this gate: both were corrected by hand in this change.
