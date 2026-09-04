# @deepseek-ai/dsh-experimental-component-kit

English | [中文](README.zh.md)

The component row behind the content panel's `component` kind. It ships React renderers and the table that names them, and nothing else: it declares no slot, reads no configuration, serves no route, and knows no layout. A placement package decides where a block is drawn; this row decides what a block looks like.

The node half is an empty plugin. It exists so the row appears in the host `cordis.yml`, which is what makes the browser bundle discoverable through `dsh.client`.

Two kinds of component live here. One is written in this repository as ordinary React and depends on nothing else. The other is a Vue 2 component compiled outside it, drawn through a bridge onto a Vue runtime another row owns. **How the originals get here**, below, records the whole of what that costs.

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

- **`toy.record`** (`TcFormDetailRenderer`) — a read-only record: label/value pairs laid out in columns. Properties: `dataList` (each `{ label, display }`), `labelWidth` (a number of pixels, turned into the CSS length the component wants), and `columnNum`. It reports nothing, so the action sink and the action state go unread. The component is `TcFormDetail` from the vendored tarball, which makes this block the one that exercises the whole Vue path.

A row whose `display` is the empty string keeps its place: the component draws the label with nothing beside it, which is what an attribute the record has but does not fill looks like. `0` and `false` are values too, and are drawn as their own text. A row is dropped only when it names nothing — no `label`, or a blank one — or when its `display` is not text at all, which a validated call cannot produce and a record written by another build can.

## How the originals get here

Some of these components were not written here. `@sumomok/toy-surface-kit` is a build of Vue 2 components lifted out of three source libraries a customer maintains. It is compiled in a repository of its own and arrives as `vendor/sumomok-toy-surface-kit-0.3.1.tgz`, declared `"@sumomok/toy-surface-kit": "file:./vendor/sumomok-toy-surface-kit-0.3.1.tgz"`. Rewriting them in React was considered and rejected: 191 of those libraries' 354 single-file components address element-ui components directly and 153 rules reach into their markup, so a rewrite would restart a bug history the customer has already paid for.

**A snapshot, not a checkout.** Overwriting the tarball in place is silently ineffective: pnpm keys the install on the file path plus an integrity hash it does not re-read for an unchanged specifier, so the build keeps the previous bytes. Every rebuild bumps the version, lands under the new file name, and updates the specifier before `pnpm install`.

**Four patches.** The build is not a straight copy: four patches are applied to the sources and shipped inside the tarball under `patches/`, with the reason for each in its `SOURCES.md`. They drop a `cronstrue` dependency, drop a download column, fix a `toUpperCase` call, and remove a token read from `localStorage`.

**Six gates that run before the tarball exists.** The build repository refuses to publish one whose artifact still contains `from 'vue'`, `'element-ui'`, `'toy-core'`, or `'toy-comp'`; whose bytes include a `fontawesome-webfont`; or which fails a jsdom mount smoke test. The first four catch a barrel import dragging in module-load side effects, the fifth catches a 1.1 MB icon font, and the last catches what none of the text gates can see — a trimmed or inlined dependency that throws while its module is being evaluated.

**One Vue, requested rather than bundled.** Vue 2 reactivity does not cross runtime copies, so this row takes `Vue` from the row that owns the only one: `dsh.client.external` names `@deepseek-ai/dsh-experimental-vue2-echarts-poc/client`, `src/client/vue-shim.ts` re-exports what it supplies, and `tsdown.config.ts` aliases the bare specifier `vue` onto that file — for the browser bundle only, and only for the bare specifier. That is why no file under `src/` may import `vue` for itself, by any spelling — a `vue/dist/…` import would reach a copy of its own, which the alias does not cover — and `tests/source-vue-imports.client.spec.ts` fails if one starts to. What an inlined library asks for is not visible in the sources at all, so `tests/client-bundle-vue.client.spec.ts` counts Vue-runtime markers in the built `lib/client.js` and fails if a second copy landed there.

**element-ui, installed once, at 300.** `installElementUI()` holds the only `Vue.use(ElementUI)` there is, and the row's client plugin calls it when it starts. `Vue.use` has no counterpart, so it is a module-scoped guard rather than an effect: tearing the row down leaves the components registered. Both options are written dead — `size: 'small'`, and `zIndex: 300` because element-ui's own default of 2000 draws a dropdown over the harness chrome at 1100 and over the approval modal at 1000, which would let an open select cover the window asking the user to approve something. The browser half of a plugin receives no cordis config and this row has no host half, so making either option a setting means a placement package reads it and passes it in.

`src/client/element-ui.css` is a physical copy of element-ui's `theme-chalk/index.css` with one edit: the icon `@font-face` carries its woff inline as a `data:` URI and no longer offers the truetype alternative, because the client bundle injects the sheet as a `<style>` tag and a relative font URL would resolve against the page instead. Regenerate it the same way after a version bump.

**Three red lines.** No `window.Vue` on the page, ever — element-ui's UMD build installs itself onto whatever it finds there, which would register its components on a runtime this row does not own and stop reactivity with no error and no warning. No `el-dialog`, `el-message`, or `el-notification` in a block: their elements sit outside the host and nothing here can close them. And every record handed to a Vue component goes through `freezeDeep` first, because Vue observes what it is given however deep — an observed array has its prototype swapped, which would reach back into data React owns. A component's listener map is the one thing that cannot be frozen: Vue rewrites the object it is given, installing an invoker over each handler, so the bridge hands it a copy and the caller's own map is left as it was written.

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
- **The tarball is a snapshot of libraries with no history** — the three source libraries have no git, no version numbers, and no change log. A customer edit cannot be diffed or even noticed, so the components here can drift from the ones the customer runs, and the only sync there is copying the sources again by hand and re-running the tarball's gates. This is a standing maintenance debt, not a warning that can be switched off.
- **element-ui's own Chinese does not follow the interface language** — a paginator's 共 x 条 and an empty table's 暂无数据 are compiled into element-ui and reach no dictionary of ours, so they stay Chinese in an English interface. Changing that means recompiling element-ui's own copy, which is its own piece of work.
- **`PopupManager.nextZIndex()` only ever counts up** — element-ui hands each new popper the next z-index from 300 and never resets the counter, so a session that opens roughly seven hundred of them climbs past the approval modal at 1000 and can cover it. Hiding a block closes the poppers it opened; nothing lowers the counter. The fix is the harness raising its own layers well above element-ui's range.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario against a real composition; the snapshot lanes replay the shipped composition, which does not compose an experimental row.
- **The one-Vue assertion over the built bundle does not run on CI** — `tests/client-bundle-vue.client.spec.ts` reads `lib/client.js`; on a pull request the only job that runs `vitest` over this package is the coverage job, which does not build, so it skips there. The master lane, `linux-primary`, runs its gates serially with the build ordered after the coverage gate, so the artifact is absent there too. It runs locally and in any lane that builds first, and the repository has no gate that reads a built client bundle's text — the two other specs of this kind, in `client/ui-trajectory` and `session/session-persistence-sqlite`, skip on CI for the same reason. What CI does cover is the consequence: the Playwright scenario draws a vendored component against the shipped bundles. The trigger for moving all three onto a gate is the first one that reads a built client bundle.
