/**
 * Package build config: the shared client preset, plus the one decision this
 * package owns — where the bare specifier `vue` resolves inside its browser
 * bundle.
 *
 * element-ui asks for `vue` by name — it is the one library inlined here that
 * does. Left alone, rolldown would resolve that request to the `vue` package
 * this manifest declares and inline a SECOND Vue 2 runtime beside the one the
 * `@deepseek-ai/dsh-experimental-vue2-echarts-poc` row already holds. Vue 2
 * reactivity does not cross runtime copies, so the components would mount and
 * then stop updating, with no error and no warning. The alias sends the request
 * to `src/client/vue-shim.ts`, which re-exports the row's copy. (The vendored
 * `@sumomok/toy-surface-kit` names neither package: its compiled components run
 * on whatever runtime renders them and resolve their `el-*` tags through the
 * global registration `installElementUI()` performs.)
 *
 * The alias matches the bare specifier and nothing else, so `vue/dist/…` would
 * still reach the manifest's own copy. Two specs stand behind it:
 * `tests/source-vue-imports.client.spec.ts` keeps this package's sources off the
 * package by any spelling, and `tests/client-bundle-vue.client.spec.ts` counts
 * Vue-runtime markers in the built `lib/client.js`, which is the only place an
 * inlined library's subpath request would show up.
 *
 * Two things about the alias target are deliberate:
 *
 * - It is a `src/` path, not the `lib/types/client/vue-shim.js` the rest of the
 *   Client face reads. `resolve.alias` runs before plugin `resolveId`, and
 *   rolldown fails hard when the target file is absent — which it is on a clean
 *   tree, since the Client tsc pass has not emitted it when this config is
 *   evaluated. This is the one place where an artifact-face module graph
 *   reaches a source-face file; the Agent Note for this change records it.
 * - It is absolute. tsdown evaluates every package config with the repository
 *   root as `process.cwd()` during a workspace build, so a relative target
 *   would resolve against the wrong directory.
 *
 * The alias applies only to the browser bundle. The Node half never imports
 * `vue`, and must not: element-ui's `lib/utils/dom.js` reads `document` at
 * module scope and throws under plain Node.
 */
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'
import { clientBundle } from '../../client/tsdown.client.ts'

const ID = '@deepseek-ai/dsh-experimental-component-kit'

/** The shared Vue 2.7 re-export every inlined `require('vue')` is sent to. */
const VUE_SHIM = fileURLToPath(new URL('src/client/vue-shim.ts', import.meta.url))

const preset = clientBundle(ID, ['lib/types/index.js', 'lib/types/invariant.js'])

/**
 * Add the `vue` alias to the browser bundle the preset built.
 * @param config - one config from the preset, for either build face.
 * @returns the browser bundle with the alias, or the config unchanged.
 */
function withVueShim(config: UserConfig): UserConfig {
  return config.platform === 'browser' ? { ...config, alias: { vue: VUE_SHIM } } : config
}

export default (inlineConfig: Pick<UserConfig, 'env'>): UserConfig[] =>
  preset(inlineConfig).map(withVueShim)
