# Agent Note: A skill-pack set installs from one packed file

Status: implemented

English | [中文](2026-09-19-skill-pack-archive-install.zh.md)

## Problem

[The pack reconciler](2026-09-18-skill-pack-reconciler.md) gave the delivery side one way to replace a deployment's packs: call `syncPackRoot` with a directory the delivery had already put on the box. That is half a delivery. A console that has built a set of packs has a file, not a directory on somebody else's host, and the deployment that receives it has an operator who copies one thing and expects one action to happen.

Two directions were untested and one of them had no answer at all. Installing a packed file was the missing direction; the other was what happens when the packed file is a different set — a pack added, a pack edited, a pack retired, and a pack whose `requires` this deployment no longer satisfies.

A packed file also arrives from outside. A directory on the box was already whatever the operator put there; a file that travelled carries the question of whether it is intact and whether it is the set it says it is, and the pack rules — no code, no path escapes, no links — have to hold against a file nobody watched being written.

## Decision

**An archive is a third delivery kind, not a second installer.** `PackDelivery` grows `{ kind: 'archive', name, bytes, limits }`, and `syncPackRoot` reads it into the same delivered set a directory produces, holds it to the same pack rules — including the manifest, view-format and view-file checks [the view-checks note](2026-09-19-skill-pack-view-checks.md) added to the staged tree — stages it into the same sibling directory and swaps it in by the same rename. The root ends up equal to the delivered set, a repeated delivery writes nothing, and a failure leaves the old root byte-identical, because those are properties of the one install path rather than of the archive.

**The manifest is the authority, and it is verified whole before anything is staged.** `pack-delivery.json` at the archive root states `format`, the set's `id` and `version`, and one SHA-256 per file; every pack file sits under `packs/<pack>/`. An archive is refused for an unknown format version, a manifest that is not one, an entry the manifest does not declare, a file it declares and the archive does not carry, a digest that does not match, a path naming no pack directory, an entry name or manifest path delivered twice, and a size or entry count over the limits it is read under. `PackInstallRefusal` carries each as a closed-union member, beside the `code-file`, `path-escape`, `symlink` and `not-a-pack` members a directory delivery already had.

**Container metadata decides nothing.** Every declared file is written as an ordinary file, so an entry another tool marked as a symbolic link, a hard link or a device cannot install as one: it is either undeclared, and refused as an entry the manifest does not declare, or written as a file holding those bytes. The installer reads no unix mode and no entry type, which is why it needs no rule about them.

**`buildPackArchive(source, set)` writes the file the installer reads.** Entries in path order, one fixed modification time written as a local-time string so the DOS date fields are the same in every timezone, and one fixed compression level: the same packs under the same identity produce the same bytes. `fflate` — already a dependency of this workspace and already in `THIRD_PARTY_NOTICES.md` — reads and writes the ZIP, so nothing here parses a container.

**A watched delivery directory is the deployment-side entry.** `deliveries.directory` plus three validated limits; the directory names the delivery. Exactly one `*.dshpack` file is the set this deployment holds, none leaves the pack root alone, and more than one is refused rather than resolved. Nothing writes into that directory: it belongs to whoever copies into it. The size is read before the bytes are, so an archive over the limit is refused without the deployment holding it.

**The set's identity is carried, never compared.** `set.id` and `set.version` are logged with what was installed and what was retired. A downgrade is an ordinary delivery.

**Installing or retiring a pack changes what the deployment offers, never what a user is allowed.** Which user is offered which pack is composition-time filtering per user, which does not exist and waits on the multi-user decision; whether a user may act through a pack's page is the customer's own backend and the approval card in front of it. Nothing in a delivery touches either.

## The decision gate

| Gate | Answer |
|---|---|
| 0. Which standing principle already decides this? | **Prefer maintained dependencies over hand-rolling** decides the container: `fflate` is already a workspace dependency with a notices entry, so the ZIP is read and written by it and no byte of container parsing is owned here. **No hardcoded tunables in plugins** decides that the three sizes are validated `Config` fields rather than constants. **Misconfiguration fails loud** decides that a relative `deliveries.directory` is refused at load and that every archive refusal is a typed error naming the entry. **Explicit > implicit at package boundaries** decides that the limits are resolved once from the schema and handed to the installer, which has no default of its own. The deployment constraint decides the entry point: `dsh` has no authentication of its own and sits behind a proxy that answers its privileged methods 403, so an unauthenticated upload route is a red line and a directory the host already controls is not. |
| 1. How many new permanent surfaces? (count, then list) | **6.** One on-disk archive format (`*.dshpack`: a ZIP carrying `pack-delivery.json` and `packs/<pack>/…`, with `format`, `set` and per-file `sha256`); one delivery kind on `PackDelivery` plus the `set` the result carries back; one exported writer, `buildPackArchive`; seven members on `PackInstallRefusal` (`duplicate-entry`, `archive-unreadable`, `archive-format`, `archive-manifest`, `archive-entry`, `archive-digest`, `archive-oversize`); one `Config` block, `deliveries`, with four fields; one watched directory with its two log lines. No new route, no new service, no new tool, no new session event, no new approval gate, and no new dependency. |
| 2. Smallest version that proves it right | `syncPackRoot` with the archive delivery kind, and `buildPackArchive` to produce one: a round trip whose result equals the directory install, byte for byte. That is what proves a packed file installs, and a delivery console calls exactly that. The watched directory is the smallest thing that lets an operator use it without an application of their own — one directory read, no route, no authority added. |
| 3. Seam or hardcode? | **Hardcode**, because the seam is already there: `PackDelivery` is the union every entry point goes through, so a second way of receiving an archive adds a caller, not an abstraction. The format is fixed for the same reason a pack's extension set is: the entry prefix, the manifest name, the compression level and the modification time are what make two runs one file, and a deployment that could vary them would be a deployment whose archives are not comparable. |
| 4. Boundaries | See below. |

### Boundaries

| Direction | The line | The failure it prevents | Term |
|---|---|---|---|
| Neighbour | This row installs packs into its own pack root and reads the delivery directory. It never writes into the delivery directory, never installs a plugin, and never runs anything an archive carries. | A deployment that consumed or renamed the file an operator handed it, and a pack root that became the way to put an executable file on the box. | 永久 |
| Contract | The manifest says what is installed; the archive's own entry metadata says nothing. Every declared file is written as an ordinary file. | An entry marked as a symbolic link, a hard link or a device becoming one on disk, and an installer that silently keeps whichever of two same-named entries a reader happened to return. | 永久 |
| Temptation | An HTTP route that takes the archive from the console directly. | An unauthenticated write into the directory this deployment installs its packs from: `dsh` has no authentication of its own, and the proxy in front of it refuses its privileged methods rather than authenticating them. | 暂缓 — trigger: the delivery console has an authenticated identity (the multi-user token work), at which point the route is authenticated where every other privileged method already is. |
| Red line | Nothing an archive carries is executed, and nothing it names is written outside the pack root. Every refusal is loud, typed, and names the entry. | The delivery path becoming the code-install path the pack rules exist to close. | 永久 |
| Ceiling | One archive is read whole into memory, bounded by `maxArchiveBytes`, and the directory names exactly one delivery. No streaming, no resume, no queue. | A half-applied delivery, and an ordering rule over several archives that nobody can state. | 暂缓 — trigger: a set that does not fit the memory a deployment will give it, which today is a loud refusal rather than an exhausted host. |
| Assumption | Whoever the host lets write the delivery directory decides what this deployment offers. The directory carries the host's own access control and none of its own. | An authority model invented inside a plugin, and a per-user answer from a package that has no user. | 暂缓 — trigger: the multi-user decision, which is also what decides which user is offered which pack. |

## Testing

Unit suites pin the archive both ways: a round trip through `buildPackArchive` and the reader, byte-identical output for the same packs whatever order they arrive in, a directory-sourced archive whose entries are the manifest first and then path order, and every refusal — unreadable bytes, an absent manifest, a manifest that is not JSON and one that is not an object, an unknown and an absent format version, a manifest field the format does not allow, a digest that is not one and bytes that do not match it, an undeclared entry (including a ZIP directory entry), a declared file the archive does not carry, a duplicate manifest path, a duplicate entry name assembled through `fflate`'s streaming writer, a declared path naming no pack directory, and each of the three limits.

Install suites cover the archive against the directory install it must equal: the two roots come out with identical digests, a second install of the same archive writes nothing, an upgrade adds and replaces, a downgrade retires, a tampered archive leaves the old root byte-identical with no staging sibling left behind, and an archive declaring a code file or an escaping path is refused before the root exists.

The delivery directory is exercised directly — an absent directory, an empty one, one archive, the same archive again, two archives, an archive over the size limit, one that does not verify, and a note, a dotfile and a directory sitting beside the real one — and through the real composition: a Loader-booted `cordis.yml` whose pack root starts empty installs the set copied into its delivery directory, withholds the delivered pack whose part nothing registers (with `plugin-absent` and `part-absent`, and its view offered to nobody) until a parts source arrives, upgrades, downgrades, refuses a directory holding two archives, refuses one whose bytes do not match its manifest, refuses one over the configured size, and stops installing when its fiber is disposed. Per-file coverage of `src` is 100%.

## Alternatives considered

**A tar container instead of a ZIP.** Rejected. Its entry types would let the installer name a symbolic-link entry in its refusal, which is the only thing it buys; it costs a new dependency in a workspace that already ships `fflate`, and the property that matters — that a link cannot install as a link — comes from writing every declared file as a file, not from reading a type field.

**Verify while staging.** Rejected. A digest checked as each file is written means a half-staged tree is the normal state of a failed install, and the staging directory then has to be reasoned about per failure. Verifying the whole archive first keeps the failure at one point.

**Let the manifest be optional and read the ZIP's own entry list.** Rejected. Without a manifest an archive cannot state what it is, a truncated file is indistinguishable from a small set, and the reader's own resolution of duplicate entry names would decide what a deployment holds.

**An authenticated upload route now.** Rejected for this change. `dsh` has no authentication of its own; the reverse proxy in front of it answers its privileged methods with 403 rather than authenticating them, so the route would be either unreachable or unauthenticated. The trigger for revisiting is recorded above.

**Consume the file after installing it — delete it or rename it to `.applied`.** Rejected. It would make a deployment write into a directory an operator owns, and it would answer "which archive is the delivery" by mutation instead of by reading. Leaving the file there makes the directory a statement of what this deployment holds, which a restart, a redeploy and a second row all read the same way.

**Pick the newest of several archives.** Rejected. Newest by name is an ordering rule, newest by mtime is a copy-tool artifact, and newest by `set.version` makes a downgrade unperformable. Refusing two archives is the only rule an operator can predict.

## Consequences

A delivery console can hand a deployment one file, and an operator can install it by copying it into a directory. What the deployment holds afterwards is exactly what that file carries, including packs it retires and packs it adds that this deployment cannot yet offer — those install, stay inactive, and say on the status route which plugin or part they are waiting for. A pack that is not waiting but broken is the other case, and [the view-checks note](2026-09-19-skill-pack-view-checks.md) refuses the delivery carrying it.

The cost is that the delivery directory is as trusted as the host's own write permissions on it, and that a deployment behind a proxy still has no way for a console to deliver over the network. Both are recorded above with what would change them.

The format is now a compatibility surface: `format: 1` is what this build reads, and a build that meets a later version refuses the archive by name rather than guessing. The archive's own bytes are reproducible for one build of this package; what identifies a set across a change of compressor is the digests in its manifest.
