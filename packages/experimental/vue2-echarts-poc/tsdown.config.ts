/**
 * Package build config: the shared client preset, plus the two decisions a
 * Vue 2.7-carrying browser bundle has to make for itself.
 *
 * 1. `vue` resolves to its runtime-only ESM build. The package's own `import`
 *    condition points at `dist/vue.runtime.mjs` under Node and at the full
 *    build for a bundler that reads `main`; pinning the file keeps the template
 *    compiler (`compileToFunctions`, the HTML parser, and their dependencies)
 *    out of a bundle that renders through `h()` and compiles no template.
 * 2. Vue 2's ESM build reads `process.env.NODE_ENV` as a bare global on every
 *    reactivity and lifecycle path. Without the define the browser throws
 *    `process is not defined` at the first component mount, so the value is
 *    substituted at build time. The shared preset defines the same key; it is
 *    restated here because the value decides which half of Vue 2's dev/prod
 *    branches survives tree shaking.
 */
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const ID = '@deepseek-ai/dsh-experimental-vue2-echarts-poc'

const preset = clientBundle(ID, ['lib/types/index.js', 'lib/types/invariant.js'])

export default (inline: Parameters<typeof preset>[0]): UserConfig[] =>
  preset(inline).map(config => config.name !== `${ID}/client` ? config : {
    ...config,
    alias: { ...config.alias, vue: 'vue/dist/vue.runtime.esm.js' },
    define: { ...config.define, 'process.env.NODE_ENV': '"production"' },
  })
