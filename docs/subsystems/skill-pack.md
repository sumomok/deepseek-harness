# Skill Packs

English | [中文](skill-pack.zh.md)

A skill pack is an ordinary skill directory whose frontmatter `metadata` also states which component plugin parts its views place. `ctx.skillPacks` is the skill provider for one directory of them, and `ctx.skillPackParts` is the optional service it reads those registered parts through. The [package README](../../packages/experimental/skill-pack/README.md) owns the manifest format, the configuration, the status document and the installer's rules; this page records the three decisions a consumer cannot read off a signature.

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts).

## Withholding can only live in the provider

[`ctx.skills`](skills.md) merges what its providers report and exposes no filter, veto or waterfall over another provider's catalog, so the only place a pack can be withheld is the provider that would otherwise have reported it. Reporting a withheld pack with both invocation flags false hides it from the model and from commands but still wins its name in the merged catalog, where it shadows a same-named skill from another provider; a withheld pack is therefore not reported at all. A deployment that mounts this row points the generic filesystem provider at its other skill roots.

Withholding is enforced at the load as well as at the listing. The registry caches a completed catalog until something invalidates it, so a selection can outlive the state it was made in, and a load re-reads the pack root and answers `undefined` unless the pack is still active.

## Activation is whole-pack

A pack whose every requirement is met is offered in full; a pack with one unmet requirement is offered to nobody — not to the model, not to user-facing commands, and none of its views, including views that read cleanly. The alternative is a page with a hole in it: a skill the model follows into a view that cannot be drawn. `statuses()` reports both kinds with every unmet requirement as a closed union, and `GET /skill-pack/status` publishes that document, because a withheld pack is invisible everywhere else by design.

## An absent parts source is an answer, not a degradation

`ctx.skillPackParts` is declared by this package and implemented elsewhere. Until a provider of it is mounted the part list is empty, so every pack naming a part is inactive. That is the fail-closed answer rather than a missing capability: a pack whose parts nothing has registered cannot draw its page either way, and the state flips the moment a provider arrives, because both the parts source's `onChange` and the watched pack root invalidate the skill catalog.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
 * @param view - the parsed view file.
 * @param claimed - view ids already taken by the deployment's own
 *   configuration or by a pack judged before this one; a view repeating one
 *   is refused, because two views under one id is one menu row whose owner is
 *   decided by load order.
 * @returns the refusal, or `undefined` when the view can be drawn here.
 */
judgeView(view: PackView, claimed: readonly string[]): PackViewRefusal | undefined
```

Source: [`packages/experimental/skill-pack/src/types.ts`](../../packages/experimental/skill-pack/src/types.ts)

<a id="ctxskillpacks--skillpackregistry"></a>

### `ctx.skillPacks` — `SkillPackRegistry`

`ctx.skillPacks`: the pack root's skill provider, and the reader of what it decided.

Both reads answer from the pack root and the parts source as they stand at the moment of the call rather than from a retained snapshot, so a caller cannot observe a state that the skill catalog has already moved past.

```ts cordis-catalog
/**
 * Judge every pack in the root as it stands now.
 * @returns one status per pack, active and inactive alike, in skill-name order.
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
 * The views of every active pack, in pack order and then manifest order.
 * An inactive pack contributes none, including views that read cleanly.
 * @returns each active pack's declared views, carrying the pack that declared them.
 */
async activeViews(): Promise<ActivePackView[]>
```

Source: [`packages/experimental/skill-pack/src/index.ts`](../../packages/experimental/skill-pack/src/index.ts)
<!-- END GENERATED cordis-surface -->
