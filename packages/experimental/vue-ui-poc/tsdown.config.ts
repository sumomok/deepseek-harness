/**
 * Package build config: the shared client preset, plus the two decisions a
 * Vue-carrying browser bundle has to make for itself.
 *
 * 1. `vue` resolves to its runtime-only ESM build. The package's own `require`
 *    condition points at the full build, which drags the template compiler
 *    (`@vue/compiler-dom`, `@babel/parser`, `entities`) into a bundle that
 *    renders through `h()` and never compiles a template at run time.
 * 2. The runtime-only build reads Vue's three feature flags as bare globals and
 *    warns at boot when a bundler leaves them undefined, so they are defined
 *    here. Options API stays on: it is what a real Vue component tree would
 *    expect, and it costs a few kilobytes rather than the compiler.
 */
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const ID = '@deepseek-ai/dsh-experimental-vue-ui-poc'

const preset = clientBundle(ID, ['lib/types/index.js', 'lib/types/invariant.js'])

const VUE_RUNTIME_DEFINES = {
  __VUE_OPTIONS_API__: 'true',
  __VUE_PROD_DEVTOOLS__: 'false',
  __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
}

export default (inline: Parameters<typeof preset>[0]): UserConfig[] =>
  preset(inline).map(config => config.name !== `${ID}/client` ? config : {
    ...config,
    alias: { ...config.alias, vue: 'vue/dist/vue.runtime.esm-bundler.js' },
    define: { ...config.define, ...VUE_RUNTIME_DEFINES },
  })
