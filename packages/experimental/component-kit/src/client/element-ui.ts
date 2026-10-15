/**
 * The row's one installation of element-ui, and the only place that decides how
 * it is configured.
 *
 * `Vue.use` registers ~80 global components on the Vue 2 runtime this package
 * shares with every other Vue 2 row and stamps `$ELEMENT` onto it, so it runs
 * exactly once: a second installation would overwrite `$ELEMENT` and reset
 * `PopupManager`'s z-index counter under the poppers already open. `Vue.use`
 * has no counterpart, so a fiber tearing this row down leaves the components
 * registered, and the guard is module-scoped rather than a `ctx.effect`.
 *
 * The client bundle compiles the stylesheet import into a plugin-owned
 * `<style data-plugin>` tag, so the sheet arrives with the components.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/element-ui
 */
import ElementUI from 'element-ui'
import Vue from './vue-shim.ts'
import './element-ui.css'

/**
 * Default control size for every element-ui component in this row. Fixed: the
 * browser half of a plugin receives no cordis config, and this row has no host
 * half to read settings through.
 */
const ELEMENT_SIZE = 'small'

/**
 * Base z-index element-ui counts its poppers up from: under the harness's own
 * chrome (1100) and the approval modal (1000), which element-ui's default of
 * 2000 would cover. The counter only increases; the README records the ceiling
 * that leaves.
 */
const ELEMENT_Z_INDEX = 300

/**
 * The names element-ui registers its select and autocomplete under, which are
 * also what every block's compiled markup resolves `el-select` and
 * `el-autocomplete` to.
 */
const CONTAINED_ASSETS = ['ElSelect', 'ElAutocomplete'] as const

/**
 * Re-register one popper-drawing component with its dropdown kept inside the
 * block that owns it.
 *
 * With `popperAppendToBody` at its default of `true`, element-ui 2.15.14 moves
 * a select's list and an autocomplete's suggestions to `document.body` when
 * they first open, which is outside the component entry `act_component` is
 * confined to: the tool could open the control and reach none of its options.
 * The subclass flips the default and registers over element-ui's own name, so
 * every such control the kits draw keeps its panel inside the block without any
 * compiled markup changing; the tarballs resolve `el-*` tags through this
 * registration rather than importing the components. The panel stays
 * absolutely positioned inside the control's own box, so popper.js still
 * places it against its trigger.
 * @param asset - the registered component name.
 * @returns nothing; the effect is on the shared runtime's global component table.
 */
function registerContained(asset: (typeof CONTAINED_ASSETS)[number]): void {
  const base = Vue.component(asset)
  Vue.component(asset, Vue.extend({
    name: asset,
    extends: base,
    props: {
      popperAppendToBody: {
        type: Boolean,
        default: false,
      },
    },
  }))
}

/** Whether {@link installElementUI} has already run against the shared runtime. */
let installed = false

/**
 * Install element-ui onto the Vue 2 runtime this row shares, once.
 *
 * Repeat calls return without touching the runtime, so a second placement
 * package mounting a second block cannot reset what the first one configured.
 * @returns nothing; the effect is on the shared runtime's prototype.
 */
export function installElementUI(): void {
  if (installed) return
  installed = true
  Vue.use(ElementUI, { size: ELEMENT_SIZE, zIndex: ELEMENT_Z_INDEX })
  for (const asset of CONTAINED_ASSETS) registerContained(asset)
}
