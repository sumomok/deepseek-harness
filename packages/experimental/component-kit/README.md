# @deepseek-ai/dsh-experimental-component-kit

English | [中文](README.zh.md)

The component row behind the content panel's `component` kind. It ships React renderers and the table that names them, and nothing else: it declares no slot, reads no configuration, serves no route, and knows no layout. A placement package decides where a block is drawn; this row decides what a block looks like.

The node half is an empty plugin. It exists so the row appears in the host `cordis.yml`, which is what makes the browser bundle discoverable through `dsh.client`.

## The renderer table

`COMPONENT_RENDERERS` maps a catalog id to the component that draws it. The keys are literal ids, so a placement package whose catalog derives a union of its own ids pins the table against that union with one `satisfies Record<CatalogId, ComponentRenderer>`, and a catalog entry this row has no renderer for becomes a compile error there rather than a blank block at runtime. The pin holds only where that union is derived from the catalog itself; a union restated by hand beside the catalog pins nothing. `ComponentSurface.tsx` in `component-surface` is the pin as written, over the `CatalogId` its `COMPONENT_CATALOG` derives.

Reaching the table is a value import across packages, so the consumer declares `dsh.client.external: ['@deepseek-ai/dsh-experimental-component-kit/client']` and the loader answers the require from this row's own bundle.

## What a renderer receives

Every component in the row takes the same five props (`ComponentRendererProps`): `nodeId`, the block's identity within one placement; `props`, the block's properties as the placement package's schema accepted them; `onAction(actionId, payload)`, where a user gesture goes, carrying the action's id and the properties that action declares; `state`, how far the gesture this block last reported got (`idle` / `sending` / `sent` / `queued` / `refused`); and `t`, this row's translate.

That is the whole contract. A renderer holds no ctx, subscribes to nothing, keeps no memory of its own gestures, and performs no navigation, no request, and no write — it draws what it was given, says what the user pressed, and is told what became of it. The placement package decides whether anything comes of that and where `state` is folded from.

Properties arrive typed as `Record<string, unknown>` because one table type serves every component, so each renderer narrows the properties it declared. The narrowing is not a defense against the caller: the block was already checked against the catalog schema that admitted it.

## Copy

The row owns one dictionary namespace, `componentKit`, and the placement package's seat declares it at its own registration rather than adding a second namespace — which components exist is this row's fact, so both the button row's accessible name and the sentence shown in place of a component this row does not have belong here. Everything else a block displays is the caller's text.

## Components

- **`el.confirm-bar`** — a short prompt over a row of buttons, for putting one decision in front of the user. Properties: `title`, `message`, and `buttons` (each `{ id, label, tone? }`, tone one of `primary` / `default` / `danger`). Pressing a button reports the `press` action, whose payload is the pressed button's `buttonId`.

A bar draws the `state` it is handed and refuses further presses in every state but `idle` and `refused`, saying which of them it is in: the gesture is on its way, the agent has it, it is waiting for the user's next message, or it reached nobody. What the placement package does with a press is a whole turn away, if it earns an answer at all, so a bar that looked untouched after a click would leave a recorded press and a lost one looking the same — and a bar remembering its own click would come back untouched anyway the first time the placement unmounts it. `refused` stays pressable, because reporting it again is the only thing left to try.

## Composition

This row is drawn by [`component-surface`](../component-surface/README.md), whose overlay composes both. Neither is part of any shipped bundle.

## Model Experience

None, as this row is a browser component library and registers no tool, prompt, or result.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The states are the placement package's to fold, and a wrong fold is invisible here** — this row draws `state` and decides nothing about it, so a placement that never advances a block past `sending`, or hands one block another's state, produces a bar that looks correct and says the wrong thing. Nothing in this row can tell.
- **The state table is closed, what a state means is not** — a bar draws one line per state it is handed, and the compiler catches a state this table has no line for. It cannot catch a placement whose new delivery grade folds into an existing state: an action a placement swallows without telling anyone, folded as `sent`, draws 已发送到对话 (`Sent to the conversation`) here. Whoever adds such a grade decides this line with it.
- **A placement's own sentences are not translated through this row** — this row localizes the lines a bar draws about its gesture, but whatever the placement package says about the same gesture elsewhere on screen carries whatever language that package wrote. The console's placement answers a press from its host, which is handed no browser locale, so `这个动作没能记下来。` and `已记下，你下次发消息时对话会看到。` appear in the chat beside a bar reading `Sent to the conversation`. Nothing here can reach them; the fix belongs to whichever placement wants one interface language, and the trigger is the console offering an interface in any other language.
- **What a payload may carry is unenforced here** — a renderer is trusted to put only what the placement package's catalog declares for that action into `onAction`'s payload; nothing in this row checks it, and the placement package refuses the whole gesture rather than trimming it. A renderer that adds a field its action does not declare makes every press of that control reach nobody.
- **One catalog, two homes** — the ids in this table and the catalog that validates a block's properties are separate declarations in separate packages, tied together only by the consumer's `satisfies` check. That check covers the ids and nothing else: a renderer whose properties drift from the schema that admitted them compiles cleanly and draws the wrong thing.
- **No component is composed with another** — a placement stacks blocks; nothing here reads a sibling block's state, and there is no layout or binding vocabulary.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
