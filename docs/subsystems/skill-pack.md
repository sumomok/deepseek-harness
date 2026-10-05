# Skill Packs

English | [中文](skill-pack.zh.md)

A skill pack is an ordinary skill directory whose frontmatter `metadata` also states which component plugin parts its views place. `ctx.skillPacks` is the skill provider for one directory of them, `ctx.skillPackParts` is the optional service it reads those registered parts through, and `ctx.skillPackIntake` installs and judges the packs an organization plugin hands over. The [package README](../../packages/experimental/skill-pack/README.md) owns the manifest format, the configuration, the status document, the installer's rules and the organization entry's fields; this page records the four decisions a consumer cannot read off a signature.

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts).

## Withholding can only live in the provider

[`ctx.skills`](skills.md) merges what its providers report and exposes no filter, veto or waterfall over another provider's catalog, so the only place a pack can be withheld is the provider that would otherwise have reported it. Reporting a withheld pack with both invocation flags false hides it from the model and from commands but still wins its name in the merged catalog, where it shadows a same-named skill from another provider; a withheld pack is therefore not reported at all. A deployment that mounts this row points the generic filesystem provider at its other skill roots.

Withholding is enforced at the load as well as at the listing. The registry caches a completed catalog until something invalidates it, so a selection can outlive the state it was made in, and a load re-reads the pack root and answers `undefined` unless the pack is still active.

## Activation is whole-pack

A pack whose every requirement is met is offered in full; a pack with one unmet requirement is offered to nobody — not to the model, not to user-facing commands, and none of its views, including views that read cleanly. The alternative is a page with a hole in it: a skill the model follows into a view that cannot be drawn. `statuses()` reports both kinds with every unmet requirement as a closed union, and `GET /skill-pack/status` publishes that document, because a withheld pack is invisible everywhere else by design.

## An absent parts source is an answer, not a degradation

`ctx.skillPackParts` is declared by this package and implemented elsewhere. Until a provider of it is mounted the part list is empty, so every pack naming a part is inactive. That is the fail-closed answer rather than a missing capability: a pack whose parts nothing has registered cannot draw its page either way, and the state flips the moment a provider arrives, because both the parts source's `onChange` and the watched pack root invalidate the skill catalog.

## An organization set is held by the fiber that handed it over

`ctx.skillPackIntake` exists only where the row configures `organizationRoot`. The organization plugin stays the only skill provider of the packs it hands over; this row installs them under `<name>@<version>`, judges each entry as a pack of the root is judged, and hands the active entries' views to the component surface, so nothing about them reaches `ctx.skills` from here. The set written last is offered while the fiber of the context the caller read the intake from is loading or loaded, an `inject` callback's own fiber included, and withdrawn when that fiber stops; its files stay on disk, and a later call handing over the same files writes nothing. A set that outlived its plugin would keep that plugin's views in the sidebar after the plugin was disabled, reloaded or failed. An active organization entry keeps a view id against the pack root, whose pack declaring it is withheld.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxskillpackintake--skillpackintake"></a>

### `ctx.skillPackIntake` — `SkillPackIntake`

`ctx.skillPackIntake`: installs the skill packs an organization hands over, and answers which of them may be offered now. The skill-pack row provides it only where `organizationRoot` is configured.

The plugin handing the packs over is their only skill provider: this package reports none of them to `ctx.skills`, and only installs them, judges them, and hands their views to the component surface.

```ts cordis-catalog
/**
 * Replace the organization root with `packs`.
 *
 * Each entry is judged on its own: an entry breaking a rule is refused and
 * not written. The accepted entries are staged and swapped in together, so
 * the root holds all of them or is left as it was. An entry waiting for a
 * plugin, a part or a platform version installs and stays inactive until
 * that arrives, without a restart. `replace([])` withdraws the set and
 * empties the root.
 *
 * The calling fiber — the fiber of the context the caller read
 * `skillPackIntake` from, an `inject` callback's own fiber included — holds
 * the set it hands over: once written, the set is offered through
 * {@link SkillPackIntake.isActive}, `ctx.skillPacks.activeViews()` and the
 * status route for as long as that fiber is active, and withdrawn when it
 * stops, its files staying on disk. Nothing is offered after a process
 * starts until the first `replace`. A set already on disk byte for byte is
 * offered without being written again.
 *
 * When the promise resolves with `ok`, `isActive` already answers from the
 * new set, and every `onChange` listener has been called after it was
 * offered. Calls run one at a time in the order they arrive, and the last
 * one offered is the set offered. A call that reaches its turn after this
 * row has stopped, or whose calling fiber is no longer active when its turn
 * comes or when its write finishes, answers `failed` and offers nothing new.
 * @param packs - every entry to offer, keyed by name and version.
 * @param options - `signal` rejects the call with its `reason`, changing
 *   nothing, while the call waits for its turn or before it writes; once the
 *   write starts the call no longer reads it.
 * @returns which entries were refused and why, or why the new set is not offered.
 */
replace(packs: readonly OrgPackInput[], options?: { readonly signal?: AbortSignal }): Promise<IntakeResult>

/**
 * Whether one entry may be offered now, judged synchronously against the
 * offered set and the parts registered at the moment of the call.
 * @param name - the entry's skill name.
 * @param version - the entry's organization manifest version.
 * @returns `true` when the offered set holds the entry and its parts, plugins,
 *   platform range, anchor format and views are all met.
 */
isActive(name: string, version: string): boolean

/**
 * Watch for a change in what {@link SkillPackIntake.isActive} answers: a set
 * offered or withdrawn, or the registered parts changing. The listener is
 * called after the change, so the read it makes sees it. The watch lasts as
 * long as the calling fiber.
 * @param listener - called after each change; it reads `isActive` again.
 * @returns the disposer that stops the watch.
 */
onChange(listener: () => void): () => void
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpackparts--partssource"></a>

### `ctx.skillPackParts` — `PartsSource`

The component surface, as a pack's requirements read it: `ctx.skillPackParts`.

Both questions come from one catalog and change together, so they are one key: a deployment that could mount the part list without the judgement would have a state where a pack's parts are known and its views are unjudged, and the pack would be offered with a view nobody can draw — which is the state this package exists to prevent.

This package declares the key and consumes it; the row that implements it over the real component catalog is separate wiring. Until a provider of the key is mounted every pack sees an empty part list, so a pack that requires any part stays inactive.

```ts cordis-catalog
/**
 * The parts registered right now.
 * @returns every registered part, in no guaranteed order.
 */
list(): readonly ProvidedPart[]

/**
 * Observe registrations and withdrawals.
 * @param listener - called after the registered set changes; it reads {@link PartsSource.list} for the new set.
 * @returns the disposer that stops the notifications.
 */
onChange(listener: () => void): () => void

/**
 * Judge one view file against the surface that would draw it.
 *
 * The judgement is the component surface's own, so a view a pack ships and a
 * block the model places are accepted on identical terms. This package reads
 * neither the spec nor the params it hands over.
 *
 * A view id the deployment's own configuration already claims is refused
 * here, because the deployment's views own their ids. Two packs claiming one
 * id is settled by this package instead: two packs of the pack root are both
 * withheld, and an offered organization pack keeps the id against the pack
 * root.
 * @param view - the parsed view file.
 * @returns the refusal, or `undefined` when the view can be drawn here.
 */
judgeView(view: PackView): PackViewRefusal | undefined
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpacks--skillpackregistry"></a>

### `ctx.skillPacks` — `SkillPackRegistry`

`ctx.skillPacks`: the pack root's skill provider, and the reader of what it decided.

Both reads answer from the pack root, the offered organization set and the parts source as they stand at the moment of the call rather than from a retained snapshot, so a caller cannot observe a state that the skill catalog has already moved past.

```ts cordis-catalog
/**
 * Judge every pack in the root, and every entry of the offered organization
 * set, as they stand now.
 * @returns one status per pack, active and inactive alike: the root's in skill-name order, then the
 *   organization set's in `name@version` order.
 */
async statuses(): Promise<PackStatus[]>

/**
 * Watch for a change in what this root offers, for as long as the calling
 * fiber lives.
 *
 * What a caller placing a pack's views needs: the answer is recomputed on
 * every read rather than cached, so the only way to learn that it moved is to
 * be told. A listener is called after the invalidation, so the read it makes
 * sees the new state.
 * @param listener - called on every change; it reads {@link SkillPackRegistry.activeViews} or
 *   {@link SkillPackRegistry.statuses} for the new answer.
 * @returns the disposer that stops the watch, which the calling fiber also runs.
 */
onChange(listener: () => void): () => void

/**
 * The views of every active pack, in pack order and then manifest order:
 * the root's packs, then the offered organization set's entries. An inactive
 * pack contributes none, including views that read cleanly, and an id two
 * active organization entries declare with one file is listed once.
 * @returns each active pack's declared views, carrying the pack that declared them.
 */
async activeViews(): Promise<ActivePackView[]>
```

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)
<!-- END GENERATED cordis-surface -->
