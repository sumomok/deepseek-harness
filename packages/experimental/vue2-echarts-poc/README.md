# @deepseek-ai/dsh-experimental-vue2-echarts-poc

English | [中文](README.zh.md)

A component library row: a real ECharts bar chart written as a **Vue 2.7** component, wrapped so React can render it anywhere. The package knows nothing about layouts and registers no slot — its browser half registers its dictionaries and exports the components. Where they render is a placement plugin's decision; [`vue2-echarts-content-poc`](../vue2-echarts-content-poc/README.md) is the one this branch ships.

It is the Vue 2 counterpart of [`vue-ui-poc`](../vue-ui-poc/README.md), which probes the same question for Vue 3.

## The bridge

The slot system takes React function components only, so the Vue tree reaches React through `Vue2Bridge`, one React component that owns a Vue root. Vue 2 has no standalone `render(vnode, container)` — the Vue 3 bridge's whole mechanism — so three Vue 2 facts shape this one instead:

- **`$mount(el)` replaces the element it is given.** The bridge therefore appends a placeholder `div` to its host and mounts onto that; the host itself stays React's, and its children belong to Vue.
- **`$destroy()` tears the instance down without touching the DOM.** Teardown removes `vm.$el` afterwards. Everything it needs is captured at mount, because React clears refs before passive cleanups run.
- **A Vue 2 root re-renders from its own reactive data, not on a parent's request.** The whole prop record therefore lives in one reactive root property and every React commit reassigns it, which patches the live tree in place. That is what keeps the Vue-internal state of the component below alive across React re-renders — the chart's click counter is the visible proof.

The record is copied and frozen on the way in. Vue 2's observer walks every object it is handed and swaps the prototype of any array it finds, so an unfrozen record would reach back into data React owns.

`props` is the entire contract between the frameworks. The React side resolves every slot share first and hands Vue a flat record of strings, arrays of plain data, a boolean, and one callback. Callbacks cross as **function-typed props**, never `on:` listeners: the props object is the whole surface, exactly as in the Vue 3 bridge. Nothing below the bridge imports React, nothing above it imports Vue, and no hook, store handle, Cordis context, or React node crosses.

## The row surface

`./client` exports two React components, and they are layered so a placement can pick the one it needs:

- **`EChartsBar`** — pure and data-driven. Its props are `title`, `categories`, `values`, and the optional `dark`, `selectedLabel`, and `onSelect`. It resolves no copy and names no slot, so the same export serves a resident column and a conversation-transcript card rendering tool-call data.
- **`ChartPanel`** — the demo wrapper over `EChartsBar`, and the component a placement registers. It resolves its copy from this package's locale seat, seeds a fixed seven-bar week, replaces it from a Randomize button, and feeds the last clicked bar back down as `selectedLabel`. Both directions cross on every interaction: Vue counts the click and React re-renders around it.

`Vue2Bridge`, `EChartsBarChart` (the Vue component), and `NS` (the dictionary namespace) are exported too, alongside the Vue 2.7 API surface: `Vue` plus `defineComponent`, `h`, `ref`, `computed`, `watch`, `onMounted`, `onBeforeUnmount`, and `nextTick`.

### One Vue runtime per module graph

Vue 2 reactivity does not cross runtime copies. An observer, a `Dep`, and a render watcher belong to the copy that created them, so a component built against a second copy of Vue silently stops updating — no error, no warning, a tree that never patches.

This bundle carries the only copy. A second Vue 2 package must therefore request this row through the module table rather than importing Vue for itself:

```jsonc
"dsh": { "client": { "external": ["@deepseek-ai/dsh-experimental-vue2-echarts-poc/client"] } }
```

and take `Vue` and the composition API from the re-exports above. The rule is what the re-exports exist for.

## Composition

The plugin is not part of any shipped bundle, and on its own it draws nothing: it is a library row plus its dictionaries. Compose it with the placement that renders its components — [`overlay/vue2-echarts-content.patch.yml`](../vue2-echarts-content-poc/overlay/vue2-echarts-content.patch.yml) mounts both rows and the shell that opens the column they land in.

The package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Bundle cost

Neither Vue nor ECharts is in the shell's shared module table, so this package's `lib/client.js` carries both: 1.30 MB raw, 290 kB gzipped. React and the Cordis/slot layers stay external and resolve through the loader's injected `require`.

Two build decisions keep it at that size rather than larger. `vue` is pinned to `vue/dist/vue.runtime.esm.js`, the runtime-only ESM build, because the full build drags the template compiler into a bundle that renders through `h()` and compiles no template. And `process.env.NODE_ENV` is defined as `"production"`, which both removes Vue 2's development branches and is required for the bundle to run at all: Vue 2's ESM build reads that name as a bare global on every reactivity path, so without the define the browser throws `process is not defined` at the first mount. ECharts is imported through `echarts/core` with only the bar chart, the grid, the tooltip, and the canvas renderer registered.

## Model Experience

None, as the package renders browser-only chart components and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Demo data only** — `ChartPanel` plots a fixed seven-bar week and randomizes it in the browser. Nothing reaches a host, a session log, or a model; `EChartsBar` is the export a data-carrying placement would use.
- **No theme plumbing** — `ChartPanel` always passes `dark: false`. A canvas resolves no CSS custom properties, so the chart's two palettes are literal values in `echarts-chart.ts` rather than the `--dsw-*` tokens the DOM around it reads, and nothing switches between them. Reaching the live theme means a registrant-private observable at the placement's register site, which is the placement's decision, not this row's.
- **Vue 2.7 is end-of-life** — 2.7 is the last Vue 2 line and receives no further releases. The package exists to prove that an existing Vue 2 component tree can be hosted, not to recommend building new ones.
- **Single-file components are not on the supported path** — the repository's Vitest configuration has no Vue plugin, so any spec reaching an SFC fails to parse, and `.vue` sits outside the coverage gate's `packages/*/*/src/**/*.{ts,tsx}` glob. This package uses `defineComponent` + `h()`; [`vue-ui-poc`](../vue-ui-poc/README.md) records the full analysis.
- **One bridge, one component** — the bridge mounts a single Vue component and passes it one prop record. Slot children, Vue `provide`/`inject` across bridges, `<Teleport>`, Vue Router, and Vuex are all unexplored.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario run against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
