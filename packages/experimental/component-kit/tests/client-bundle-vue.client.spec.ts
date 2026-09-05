/**
 * The artifact half of "one Vue on the page": the built client bundle carries
 * no Vue 2 runtime of its own.
 *
 * `tsdown.config.ts` aliases the bare specifier `vue` onto the shim, and
 * `tests/source-vue-imports.client.spec.ts` keeps this package's own sources
 * off the package. Neither reaches the case this file is for: an inlined
 * library asking for a subpath such as `vue/dist/vue.runtime.common.js`
 * resolves to the `vue` this manifest declares and lands a second runtime in
 * the bundle, with no build error and no warning. Two Vue 2 copies do not share
 * reactivity, so a component built against the second one mounts and then stops
 * updating.
 *
 * This reads the built artifact rather than the sources, so it skips when
 * `lib/client.js` is absent (`pnpm --filter
 * @deepseek-ai/dsh-experimental-component-kit run bundle`).
 *
 * **CI does not execute these two assertions.** On a pull request the only job
 * that runs `vitest` over this package is the coverage job, which does not
 * build. The master lane, `linux-primary`, runs its gates serially with the
 * build ordered after the coverage gate, so the artifact is absent there as
 * well, and both assertions skip in either case; they run locally, and in any
 * lane that builds first. The repository has no gate that reads a built client
 * bundle's text — `verify-built-package-invariants` reads the compiled
 * companion of every package, not one package's bundle — and the two other
 * specs of this kind, `client/ui-trajectory/tests/client-bundle.client.spec.ts`
 * and `session/session-persistence-sqlite/tests/built-package.spec.ts`, skip on
 * CI for the same reason. Hanging this one assertion on a gate script of its
 * own would give an experimental row CI coverage that shipped rows with the
 * same kind of assertion do not have; the trigger for moving all three is the
 * first gate that reads a built client bundle. Until then, what CI does cover
 * is the consequence rather than the cause: `apps/web/tests/component-surface.e2e.ts`
 * draws a vendored component in a real browser against the shipped bundles, and
 * a page whose element-ui landed on a runtime the component does not render on
 * fails there.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Identifiers a second Vue 2 runtime brings into the bundle: the instance
 * brand, the patch entry hung on the prototype, and the observer's property
 * rewriter. All three are property or local names the bundler preserves; a
 * plain function name such as `initGlobalAPI` is renamed on the way in and
 * reads as zero whether a second runtime is there or not.
 */
const VUE_RUNTIME_MARKERS = ['_isVue', '__patch__', 'defineReactive'] as const

/** The one module request that supplies this row's Vue, as the bundle writes it. */
const SHARED_RUNTIME_REQUEST = 'require("@deepseek-ai/dsh-experimental-vue2-echarts-poc/client")'

/**
 * Count each Vue-runtime marker in bundled code.
 * @param code - the bundle's text.
 * @returns one count per marker, in {@link VUE_RUNTIME_MARKERS} order.
 */
function markerCounts(code: string): Record<string, number> {
  return Object.fromEntries(
    VUE_RUNTIME_MARKERS.map(marker => [marker, code.split(marker).length - 1]),
  )
}

/**
 * Read the built browser bundle.
 * @returns the bundle's text, or `undefined` when the package has not been bundled.
 */
function readBundle(): string | undefined {
  try {
    // vitest runs from the repository root; import.meta.url is http-scheme in
    // the jsdom pool, so the artifact is resolved repo-relatively.
    return readFileSync(resolve('packages/experimental/component-kit/lib/client.js'), 'utf8')
  } catch {
    return undefined
  }
}

describe('the built client bundle', () => {
  const code = readBundle()

  it.skipIf(code === undefined)('inlines no Vue runtime of its own', () => {
    expect(markerCounts(code as string)).toEqual({ _isVue: 0, __patch__: 0, defineReactive: 0 })
  })

  it.skipIf(code === undefined)('asks the row that owns the shared runtime for it, once', () => {
    expect((code as string).split(SHARED_RUNTIME_REQUEST).length - 1).toBe(1)
  })

  it('recognizes an inlined runtime when there is one', () => {
    // The gate is only as good as the markers behind it, and an artifact that
    // is already clean cannot show that they would catch a second copy.
    expect(markerCounts('vm._isVue = true; Vue.prototype.__patch__ = patch')).toEqual({
      _isVue: 1, __patch__: 1, defineReactive: 0,
    })
  })
})
