# @deepseek-ai/dsh-experimental-component-kit

English | [中文](README.zh.md)

The component row behind the content panel's `component` kind. It ships React renderers and the table that names them, and nothing else: it declares no slot, reads no configuration, serves no route, and knows no layout. A placement package decides where a block is drawn; this row decides what a block looks like.

The node half is an empty plugin. It exists so the row appears in the host `cordis.yml`, which is what makes the browser bundle discoverable through `dsh.client`.

## The renderer table

`COMPONENT_RENDERERS` maps a catalog id to the component that draws it. The keys are literal ids, so a placement package whose catalog derives a union of its own ids pins the table against that union with one `satisfies Record<CatalogId, ComponentRenderer>`, and a catalog entry this row has no renderer for becomes a compile error there rather than a blank block at runtime. The pin holds only where that union is derived from the catalog itself; a union restated by hand beside the catalog pins nothing. `ComponentSurface.tsx` in `component-surface` is the pin as written, over the `CatalogId` its `COMPONENT_CATALOG` derives.

Reaching the table is a value import across packages, so the consumer declares `dsh.client.external: ['@deepseek-ai/dsh-experimental-component-kit/client']` and the loader answers the require from this row's own bundle.

## What a renderer receives

Every component in the row takes the same four props (`ComponentRendererProps`): `nodeId`, the block's identity within one placement; `props`, the block's properties as the placement package's schema accepted them; `onAction(actionId, nodeId)`, where a user gesture goes; and `t`, this row's translate.

That is the whole contract. A renderer holds no ctx, subscribes to nothing, and performs no navigation, no request, and no write — it draws what it was given and says what the user pressed. The placement package decides whether anything comes of that.

Properties arrive typed as `Record<string, unknown>` because one table type serves every component, so each renderer narrows the properties it declared. The narrowing is not a defense against the caller: the block was already checked against the catalog schema that admitted it.

## Copy

The row owns one dictionary namespace, `componentKit`, and the placement package's seat declares it at its own registration rather than adding a second namespace — which components exist is this row's fact, so both the button row's accessible name and the sentence shown in place of a component this row does not have belong here. Everything else a block displays is the caller's text.

## Components

- **`el.confirm-bar`** — a short prompt over a row of buttons, for putting one decision in front of the user. Properties: `title`, `message`, and `buttons` (each `{ id, label, tone? }`, tone one of `primary` / `default` / `danger`). Pressing a button reports its id.

## Composition

This row is drawn by [`component-surface`](../component-surface/README.md), whose overlay composes both. Neither is part of any shipped bundle.

## Model Experience

None, as this row is a browser component library and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **A pressed button reaches nobody yet** — `onAction` is the renderer's whole return path, and the placement package that draws these blocks today passes a callback that does nothing. A user can press a button and see no effect anywhere; the channel that carries the press back to the agent is a later phase.
- **One catalog, two homes** — the ids in this table and the catalog that validates a block's properties are separate declarations in separate packages, tied together only by the consumer's `satisfies` check. That check covers the ids and nothing else: a renderer whose properties drift from the schema that admitted them compiles cleanly and draws the wrong thing.
- **No component is composed with another** — a placement stacks blocks; nothing here reads a sibling block's state, and there is no layout or binding vocabulary.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
