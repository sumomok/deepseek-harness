# @deepseek-ai/dsh-experimental-vue-ui-poc

English | [中文](README.zh.md)

Feasibility probe for hosting a non-React UI framework inside the web GUI. It contributes one entry to `conversation.session.header.actions` — the same additive seat [`dsh-client-ui-jobs`](../../client/ui-jobs/README.md) uses — whose body is a Vue 3 component. Nothing about the plugin protocol changes: it is an ordinary dual-face package with an empty node half, a `dsh.client` declaration, and a `./client` bundle.

## What the probe shows

The slot system takes React function components only, so the Vue tree reaches the seat through `VueBridge`, one React component that owns a Vue render root. The bridge calls Vue's low-level `render(vnode, container)` rather than `createApp`: an app instance carries its own plugin, provide, and config realm that would be built and discarded on every React commit, while repeated `render` calls against one container diff instead, which is what keeps the Vue tree's reactive state alive across React re-renders. Teardown is a `render(null, container)` captured at mount, because React clears refs before passive cleanups run.

`props` is the entire contract between the frameworks. The React half resolves every slot share first — the locale seat `t`, and its own `useState` echo — and hands Vue a flat record of strings, one number, and one callback. Nothing below the bridge imports React, nothing above it imports Vue, and no hook, store handle, Cordis context, or React node crosses. TypeScript checks that record against the Vue component's declared props at the call site, so a renamed prop is a build error rather than a silent `undefined` in the template.

The probe component keeps its counter in a Vue `ref` and reports each new value through an `onCount` prop. Clicking it therefore exercises both directions at once: Vue's own reactivity updates the count, React stores the value and re-renders, and the bridge patches the live tree so the count survives while the echo changes. Styling is CSS Modules through the shared client build pipeline, tokens only, so the Vue tree follows theme switches exactly like a React component.

## Composition

The plugin is not part of any shipped bundle. Compose it as an overlay over the Web surface:

```yaml
- insert:
    - id: vue-ui-poc
      name: '@deepseek-ai/dsh-experimental-vue-ui-poc'
```

`tests/vue-ui-poc.overlay.yml` is that file; `dsh --profile web --patch <path>` applies it. The package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Bundle cost

Vue is not in the shell's shared module table, so this package's `lib/client.js` carries its own Vue runtime; React and the Cordis/slot layers stay external and resolve through the loader's injected `require`. The package build config pins `vue` to its runtime-only ESM build and defines Vue's three feature flags, because the package's own `require` condition points at the full build and would drag the template compiler (`@vue/compiler-dom`, `@babel/parser`, `entities`) into a bundle that renders through `h()` and compiles no template at run time. That pin is the difference between a 1.16 MB and a 317 kB artifact.

A second Vue-carrying plugin would ship a second copy. Sharing one runtime across plugins is a module-table decision (`PLATFORM_MODULES` in `packages/client/web/src/platform.ts`), not something a plugin can arrange for itself.

## Model Experience

None, as the package renders a browser-only control and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Single-file components are not on the supported path** — `.vue` files compile in both tsdown faces once the package config adds `unplugin-vue` plus a resolver that rebases the tsc-emitted `./x.vue` specifier back onto `src/`, but the repository's Vitest configuration has no Vue plugin, so any spec reaching an SFC fails to parse, and `.vue` sits outside the coverage gate's `packages/*/*/src/**/*.{ts,tsx}` glob. Without `vue-tsc`, an SFC's props also erase to `Record<string, unknown>`, which drops the compile-time prop check the render-function form keeps. Adopting SFCs is therefore a repository-wide tooling decision, not a package-local one; this package uses `defineComponent` + `h()`.
- **One bridge, one component** — the bridge mounts a single Vue component and passes it one prop record. Slot children, Vue `provide`/`inject` across bridges, `<Teleport>` targets outside the container, and Vue Router or Pinia are all unexplored.
- **No shared runtime** — see Bundle cost above; every Vue plugin pays for its own copy until the module table says otherwise.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario run against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
