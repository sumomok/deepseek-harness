# @deepseek-ai/dsh-experimental-vue2-echarts-content-poc

English | [中文](README.zh.md)

A placement, and nothing else: it puts [`vue2-echarts-poc`](../vue2-echarts-poc/README.md)'s `ChartPanel` into the `content` column that [`server-layout`](../server-layout/README.md) opens. The whole browser half is one `slots.inject` call; the node half is empty.

## Why it is a separate package

`content` belongs to this product line's shell, which exists on the `product/server-console` branch alone. The chart components do not: a Vue 2.7 tree hosted in React is useful wherever it is rendered, including a conversation-transcript card on a branch that has no `content` slot at all. Splitting the two lets the component row travel while the placement stays behind — merging the components is then a package move, not a rewrite, and a second placement is a file this size.

`content` is a `single` slot, so this row and [`content-frame`](../content-frame/README.md) are alternatives. A composition mounts one or the other; the two cannot both occupy the column.

## The module request

`ChartPanel` is a value import across package boundaries, which the client bundle purity gate normally rejects outright. It is allowed here because the manifest declares the request:

```jsonc
"dsh": { "client": { "external": ["@deepseek-ai/dsh-experimental-vue2-echarts-poc/client"] } }
```

Three mechanisms then act on that one line. The build preset leaves the specifier an import instead of inlining it, so this bundle is a kilobyte and carries neither Vue nor ECharts. The modules node half reads the request and orders the component row ahead of this one in the boot graph, so the factory is registered before this one materializes. And `verify-client-packages` checks that a dynamic row actually supplies the specifier and that the request graph stays acyclic.

Sharing the module identity is also what keeps **one Vue runtime** in the graph — the rule the component row's README states, and the reason this package must never `import 'vue'` itself.

## Composition

The plugin is not part of any shipped bundle. Compose it as an overlay over the Web surface:

```yaml
- id: ui-layout
  name: '@deepseek-ai/dsh-client-ui-layout'
  disabled: true

- insert:
    - id: server-layout
      name: '@deepseek-ai/dsh-experimental-server-layout'
    - id: vue2-echarts-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-poc'
    - id: vue2-echarts-content-poc
      name: '@deepseek-ai/dsh-experimental-vue2-echarts-content-poc'
```

`overlay/vue2-echarts-content.patch.yml` is that file; `dsh --profile web --patch <path>` applies it. All three rows are required: the shipped shell declares no `content` key, and the component row is both this bundle's module supplier and the registrant of the copy the panel reads. Each package must be resolvable from the profile directory, which for an out-of-tree plugin means `dsh plugin --profile web add <path>` or an equivalent link — release bundles must not declare an experimental package.

## Model Experience

None, as the package places a browser-only chart panel and touches no prompt, message, schema, stream, or tool result.

#### KV Cache effect

None; the package never assembles or sends provider requests.

## Known Limitations and Deferred Work

- **Bound to the service-line shell** — the row registers into `content`, a key only `server-layout` declares. On a composition with the shipped shell it waits for a declaration that never arrives and contributes nothing.
- **No configuration** — which component occupies the column is decided in source. A deployment that wants a different panel writes a different placement package.
- **Not covered by an assembled snapshot** — the browser evidence is a Playwright scenario run against a real composition, not a recorded transcript; the snapshot lanes project model-visible and conversation output, which this package has none of.
