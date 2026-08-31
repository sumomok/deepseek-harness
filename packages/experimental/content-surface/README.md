# @deepseek-ai/dsh-experimental-content-surface

English | [中文](README.zh.md)

The service-line shell opens one content column, and more than one package wants it. This row turns that single seat into a router: host plugins register **extractors** that recognize their own already-logged events, and this row folds them into one per-session stream of typed **entries**. Drawing them is [`content-column`](../content-column/README.md)'s job — the two halves are separate packages because a Cordis service and a browser plugin cannot share one Typert face.

Almost nothing here is a new fact. Every entry is derived from something another package already writes to the session log — `content/shown` for a page, a `show_chart` call for a chart — so the column is reconstructable from the log alone. The one exception this row owns directly is dismissal: closing an entry's tab is not a fact any other package's log carries, so this package appends `content-surface/dismissed` itself (see "Dismissing an entry" below).

## The entry stream

An entry is `{ kind, entryId, seq, title, payload }`. `kind` names the extractor that produced it and the client slot key that draws it; `entryId` is its identity **within** that kind, and a later record naming the same pair replaces the earlier one rather than adding a second row. That is what makes a redrawn chart and a re-shown page one entry each. The published value lists the live entries newest first, so `entries[0]` is what the column shows until the user picks something else.

The [subsystem page](../../../docs/subsystems/content-surface.md) carries the literal `ContentSurfaceExtractor`, `ContentSurfaceRecord`, and `ContentSurfaceEntry` declarations.

## `ContentSurfaceRegistry` (ctx key: `contentSurface`)

`ctx.contentSurface.register(extractor): () => void` takes one kind's whole contribution and returns the disposer (an effect on the calling fiber, so a row that unloads takes its kind with it):

- `kind` — the entry kind, and the `content.surface.kind` key its renderer claims.
- `dataVersion` — invalidation anchor for the stored `data`; bump it when the stored shape or the reading rules change.
- `read(event)` — the draft (`{ entryId, data }`) this committed event records, or `undefined`. Synchronous and pure: it runs inside the session projection's fold.
- `resolve(data)` — the `{ title, payload }` the browser receives, computed against whatever the kind's host row knows **now**. Synchronous and pure: it runs inside the projection's view, and its output must be plain JSON.

Extractors see each event in registration order and the first draft wins, so two kinds must not claim one event. The registry owns one session projection, `contentSurface`, and registering the extractors is all a kind's host row does here.

### Registration timing is free, and what it costs

The projection registry fixes a unit's fold and its `stateVersion` at registration, then caches one folded cell per session and never revisits it. A router reading a live extractor table inside one long-lived unit would therefore leave every session that already had a cell permanently missing a late kind's history.

So this registry registers a **new** unit for every table change. The projection registry drops the old unit's cells with it, and each session's next touch refolds from `init` over its whole in-memory log through the new table. `stateVersion` is derived from the table — the sorted `kind@dataVersion` list, hashed — for the same reason on the durable side: a persisted checkpoint written under a different set of kinds is discarded instead of forward-applied into a stream missing everything the added kind would have found.

The one cost is push latency. The registry publishes a changed value only while driving an event, so a browser already connected when a kind row is hot-loaded reads the previous stream until that session's next event. Boot-time composition never hits this; HMR does.

## Dismissing an entry

The switcher strip's close button executes `/dismiss-content-entry <kind> <entryId>` against the current session, through `ctx.commands.execute` — the same command seam every other user-triggered write in this router's neighborhood uses (`content-frame`'s `show-content-page`). The handler splits its raw input on the first space (`kind` values never carry whitespace; `entryId` keeps everything after that space, whole) and appends `content-surface/dismissed` with `by: 'user'`.

`projection.ts`'s fold treats this event as the one case that bypasses the extractor table entirely: it removes the named `(kind, entryId)` record outright rather than running any `read`. Nothing validates the pair against the live stream first — this router keeps no catalogue of which pairs currently exist, so a dismissal naming a pair that is already gone (two clicks racing, a stale tab reopened from history) is an ordinary no-op fold, not a rejected command. A later record naming the same pair (the agent redraws the chart, the user re-navigates to the page) is an ordinary fresh insert once the dismissed record is gone, so a dismissed entry resurrects exactly like one that was never dismissed — dismissal only ever removes, it never suppresses a future write.

`content-surface/dismissed` is not `ignorable`: an older build that does not know this event type refuses the log rather than silently treating a dismissed entry as still live. Adding it did not bump `SESSION_FORMAT_VERSION` (ordinary vocabulary growth), but it did bump the fold's own semantics version folded into every `stateVersion` (see `extractor.ts`'s `FOLD_SEMANTICS_VERSION`) — a checkpoint written before this fold could remove a record is discarded rather than replayed under a rule that did not exist when it was written.

Content-column hides this command's own chat echo the same way [`content-frame`](../content-frame/README.md) hides `show-content-page`'s: the durable record is the point, not a chat message narrating a click the user just made.

## Composition

Neither this package nor the shell is part of any shipped bundle. [`overlay/full-surface.patch.yml`](overlay/full-surface.patch.yml) composes the everything demo — the shell, both halves of the surface, [`content-frame`](../content-frame/README.md)'s `page` kind over a hosted application, and [`vue2-echarts-tool-poc`](../vue2-echarts-tool-poc/README.md)'s `chart` kind:

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: content-surface
      name: '@deepseek-ai/dsh-experimental-content-surface'
    - id: content-column
      name: '@deepseek-ai/dsh-experimental-content-column'
    - id: content-frame
      name: '@deepseek-ai/dsh-experimental-content-frame'
      config:
        root: !!js process.env.DSH_CONTENT_APP_ROOT
        pages: [...]
    - id: vue2-echarts-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-poc'
    - id: show-chart
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc'
```

`dsh --profile web --patch <path>` applies it, with `DSH_CONTENT_APP_ROOT` naming the hosted application. Every package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

Both children are optional. An assembly without `ctx.sessionProjections` keeps the extractor table, publishes nothing, and the column shows its empty state; an assembly without `ctx.systemPrompt` keeps the table and contributes no guidance. Neither is a precondition for the other, and the row is composed the same way either way.

## Model Experience

### System prompt: working with content already on display

#### What the model sees

One section, `content:on-display`, registered whenever a system-prompt registry is composed and independent of which kinds are — the rule is about what the **user** points at, so an empty extractor table is not a reason to withhold it. The text names no kind, no tool, and no argument, so a kind added later inherits it with no edit here while each tool's own schema keeps saying how its identity is spelled. It orders at `200`, past the `100–199` tool-guidance band, so it is read against whatever each tool just said; [the Agent Note](../../../.agents/notes/implemented/feature/2026-08-24-content-on-display-rule.md) carries the measurement that made both the wording and the position deliberate.

##### The section, verbatim

```markdown
# Working with content already on display

When the user refers to something you have already produced and put on display — quoting it, naming its title, or otherwise pointing at it — and asks for a change, update that same piece of content in place through the tool that produced it, reusing its identity, rather than producing a new one beside it.
```

#### Token effect

About 70 words of static text, carried in every request of every turn of every agent in the composition, whether or not that session has ever put anything on display. Nothing here is data-dependent, so the cost does not grow with the entry stream.

#### KV Cache effect

Prefix-stable: the text is static and orders after every section registered today, so the assembled prompt gains a constant tail and the prefix ahead of it is untouched. Loading or unloading this row changes the prompt and invalidates reuse from that tail; a section registered at an order above `200` would push this one earlier and invalidate reuse from wherever it lands.

## Known Limitations and Deferred Work

- **A kind may store a whole document** — the fold keeps one record per live entry, but that record holds whatever the extractor put in `data`, and the `chart` kind puts the option there. A session with many live charts carries them all in the projection state, the wire value, and the persisted checkpoint.
- **A derived `stateVersion` can collide** — the table's signature is hashed into 31 bits, so two different compositions could in principle share a version and thereby a checkpoint. The remedy if it ever happens is a `dataVersion` bump on any kind involved.
- **A hot-loaded kind does not push** — the projection registry has no republish call, so a browser connected before the row loaded reads the previous stream until that session's next event.
- **No ordering control** — entries are ordered by the seq that last recorded them, and a kind cannot ask to lead or trail.
- **The rule's position is a convention** — order `200` is past the documented `100–199` tool-guidance band, but nothing reserves it: a later section taking a higher order silently moves the rule off the end of the prompt, which is where it was measured. `apps/web/tests/content-surface.e2e.ts` asserts the tail against a real composition, so the Web surface at least fails loudly.
- **One event, one kind** — the first extractor that recognizes an event wins it, and nothing detects two kinds reading the same event. Kinds derived from distinct tool calls or distinct event types do not collide.
- **A dismissal is never validated against the live stream** — the command appends `content-surface/dismissed` for whatever `(kind, entryId)` its input names, without checking that an entry so identified currently exists. That is a deliberate design choice (see "Dismissing an entry" above), not an oversight, but it also means a malformed client could dismiss a pair that never existed with no error surfaced anywhere.
- **Split from its browser half by the toolchain** — a package whose host entry declares a Cordis service and whose `src/client` reaches the client runtime puts both faces' Context merges in one Typert program, which fails the generator on a duplicated key. Keeping the service here and the column in [`content-column`](../content-column/README.md) is what avoids that; the two are composed together and neither is useful alone.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
