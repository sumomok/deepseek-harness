# Agent Note: A Vue 2.7 bridge, and the component/placement split that lets the component travel

Status: implemented

English | [中文](2026-08-24-vue2-bridge-echarts-poc.zh.md)

## Problem

[The Vue 3 probe](../../../../packages/experimental/vue-ui-poc/README.md) answered whether a foreign framework can live in a React slot, using Vue 3's standalone `render(vnode, container)`. Vue 2 has no such function, and the code base this product line has to host is Vue 2, not Vue 3. Nothing had been proven for it: not the mount mechanism, not what happens to Vue reactivity across a React commit, and not what a second Vue 2 package would cost.

A second question came with it. The visible surface for this branch is the service-line shell's `content` column, which `develop` does not have — the shipped shell declares no `content` key. A component written against that column could never merge; a component that knows nothing about it can.

## Decision

Two roles, and the component one is its own package. `vue2-echarts-poc` carries the Vue 2.7 runtime, the bridge, the ECharts component, two React components, and the dictionaries; it registers no slot. A placement is a `slots.inject(<key>, …)` call and an overlay, and lives with whatever feature owns the data it draws — [the content-surface router](2026-08-24-content-surface-router.md) is what the placements register into today.

### The bridge owns a Vue root, not a container

Three Vue 2 facts decide `Vue2Bridge`'s shape:

- `$mount(el)` **replaces** the element it is given, so the bridge appends a placeholder `div` to its host and mounts onto that. The host stays React's; its children belong to Vue.
- `$destroy()` leaves the DOM alone, so teardown removes `vm.$el` afterwards. Both the root and the element are captured at mount, because React clears refs before passive cleanups run.
- A Vue 2 root re-renders from its own reactive data. The whole prop record therefore lives in one reactive root property, and every React commit reassigns it — `vm.p = props` patches the live tree, which is what keeps the Vue-internal state below it alive.

The record is copied and frozen on the way in. Vue 2's observer walks every object handed to it and swaps the prototype of any array it reaches, so an unfrozen record would mutate data React owns.

### Component and placement are separate packages

`ChartPanel` and `EChartsBar` name no slot and resolve nothing from a layout; `EChartsBar` resolves no copy either, so a placement that renders tool-call data in a conversation transcript passes its own strings. What stays on this branch is the placement, a dozen lines wherever it sits. Merging the components elsewhere is a package move plus a new placement of the same size, not a rewrite.

### The first package-row module request in the repository

The placement value-imports `ChartPanel` across a package boundary, which the client bundle purity gate rejects unless the manifest declares the request. `dsh.client.external: ['@deepseek-ai/dsh-experimental-vue2-echarts-poc/client']` is documented in [the client stack's module-graph rules](../../../../packages/client/AGENTS.md#shared-modules-and-the-module-graph) and had no user until now. Three mechanisms answered it as documented: the build preset left the specifier an import, so the placement bundle is 1 kB and carries neither Vue nor ECharts; the modules node half ordered the component row ahead of its consumer in the boot graph; and `verify-client-packages` confirmed a dynamic row supplies the specifier and the request graph is acyclic.

Sharing that module identity is also the mechanism behind the runtime rule below, which is why the component row re-exports `Vue` and the composition API rather than leaving a consumer to `import 'vue'`.

## Alternatives considered

**Create a fresh `new Vue` per React commit.** Rejected: a Vue 2 root carries its own reactive graph and lifecycle, so rebuilding it on every commit throws away exactly the state the bridge exists to preserve, and remounts the ECharts canvas with it. Reassigning one reactive property costs a patch pass instead.

**Cross callbacks as `on:` listeners rather than function props.** Rejected. Vue 2 accepts `Function` props, and keeping the props object as the entire contract means one type-checked record at the call site and no second channel to reason about — the same rule the Vue 3 bridge settled.

**Single-file components.** Rejected as a repository-wide tooling decision rather than a package one: the Vitest configuration has no Vue plugin, so a spec reaching an SFC fails to parse, and `.vue` sits outside the coverage gate's glob. `defineComponent` + `h()` also keeps the compile-time prop check that an SFC without `vue-tsc` erases.

**One package registering straight into `content`.** Rejected: it welds the components to a slot key that exists on this branch only, so nothing could merge without being rewritten.

**Let each Vue 2 package inline its own Vue.** Rejected — it does not merely cost bytes, it breaks silently. Vue 2 reactivity does not cross runtime copies: an observer, a `Dep`, and a render watcher belong to the copy that created them, so a component built against a second copy stops updating with no error and no warning.

## Consequences

**One Vue runtime per module graph** is now a rule with a mechanism behind it. A second Vue 2 package requests `@deepseek-ai/dsh-experimental-vue2-echarts-poc/client` through `dsh.client.external` and takes `Vue`, `defineComponent`, `h`, `ref`, `computed`, `watch`, `onMounted`, `onBeforeUnmount`, and `nextTick` from that row's re-exports. Those value exports exist for that purpose and are stated in the package README.

The component row's bundle is 1.30 MB raw and 290 kB gzipped, carrying Vue 2.7 and a tree-shaken ECharts. Two build decisions hold it there: `vue` pinned to `vue/dist/vue.runtime.esm.js`, and `process.env.NODE_ENV` defined as `"production"` — the second is not an optimization but a requirement, since Vue 2's ESM build reads that name as a bare global and the browser otherwise throws `process is not defined` at the first mount.

A `develop`-side placement is a separate small plugin whenever it is wanted; the components do not move for it. The chart reads no theme: a canvas resolves no CSS custom properties, so its two palettes are literal values and `ChartPanel` always selects the light one.

## Testing

`vue2-bridge.client.spec.tsx` drives the bridge over a throwaway Vue component: what the host contains after mount, that a React commit keeps the same element and the Vue counter while the label changes, that callbacks cross, that unmount leaves the host empty, and that the record React handed over is never stamped with Vue's `__ob__`.

`chart-panel.client.spec.tsx` replaces ECharts and `ResizeObserver` with recorders, because jsdom has neither canvas nor layout. It covers `EChartsBar`'s data path and each optional input's default, the click that moves Vue's counter and React's state together, a data change applied to the live instance, a palette change rebuilding it, the observer-driven resize, and the disposal pair on unmount — then `ChartPanel`'s seeded week, its selection echo, and Randomize.

`apps/web/tests/show-chart.e2e.ts` and `apps/web/tests/content-surface.e2e.ts` boot real Web compositions and prove a sized `<canvas>` comes out of the bridge in the transcript and in the content column. `ChartPanel`'s own browser evidence went with the demo placement that rendered it; the component keeps its jsdom spec and no placement.
