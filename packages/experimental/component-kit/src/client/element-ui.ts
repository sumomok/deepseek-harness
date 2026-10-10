/**
 * The row's one installation of element-ui, and the only place that decides how
 * it is configured.
 *
 * element-ui is a Vue 2 plugin: `Vue.use` registers ~80 global components on a
 * runtime's prototype and stamps `$ELEMENT` onto it. That is process-wide state
 * on a runtime this package shares with every other Vue 2 row, so it must
 * happen exactly once and from one place — a second installation would
 * overwrite `$ELEMENT` and reset `PopupManager`'s z-index counter under the
 * poppers the first one already opened.
 *
 * Installing is not reversible: `Vue.use` has no counterpart, so a fiber that
 * tears this row down leaves the components registered. That is why this is a
 * plain module-scoped guard rather than a `ctx.effect`.
 *
 * The stylesheet ships with this module: the client bundle compiles the import
 * into a plugin-owned `<style data-plugin>` tag injected when the bundle is
 * materialized, so the sheet arrives with the components rather than from a
 * second request the deployment would have to serve.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/element-ui
 */
import ElementUI from 'element-ui'
import Vue from './vue-shim.ts'
import './element-ui.css'

/**
 * Default control size for every element-ui component in this row.
 *
 * Written dead rather than configurable: the browser half of a plugin receives
 * no cordis config, and this row has no host half to fetch settings through.
 * Making it a setting means a placement package reads the setting and calls
 * {@link installElementUI} with it, which is a change to the call site rather
 * than to this constant.
 */
const ELEMENT_SIZE = 'small'

/**
 * Base z-index element-ui counts its poppers up from.
 *
 * element-ui defaults to 2000, which draws its dropdowns over the harness's own
 * chrome (1100) and over the approval modal (1000) — a select left open would
 * cover the window asking the user to approve something. 300 puts every popper
 * under both. The counter only ever increases, so a session that opens roughly
 * 700 poppers eventually climbs past the modal again; that ceiling is recorded
 * in this package's README.
 */
const ELEMENT_Z_INDEX = 300

/**
 * The name element-ui registers its select component under, which is also what
 * every block's compiled markup resolves its `el-select` tag to.
 */
const SELECT_ASSET = 'ElSelect'

/**
 * The name element-ui registers its autocomplete component under, which is
 * also what every block's compiled markup resolves its `el-autocomplete` tag to.
 */
const AUTOCOMPLETE_ASSET = 'ElAutocomplete'

/**
 * The select whose dropdown is drawn inside the block that owns it.
 *
 * element-ui's select renders its dropdown as a child of the select and then,
 * with `popperAppendToBody` at its default of `true`, appends that child to
 * `document.body` when the list is first opened (`createPopper` in the 2.15.14
 * popper mixin). A dropdown on the body is outside the block and outside the
 * component entry `act_component` is confined to, so the tool could open a
 * select and then reach none of its options: the click that chooses one is
 * refused by the confine before this change. The subclass registers over
 * element-ui's own name with the default flipped, so every `el-select` the kits
 * draw — the write dialogs' fields, the query panels, the condition renderers —
 * keeps its list inside the block without any compiled markup changing. The
 * tarballs resolve `el-*` tags through this registration rather than importing
 * the components, which is what makes an override here reach them all.
 *
 * The dropdown stays absolutely positioned inside the select's own positioned
 * box, so popper.js keeps placing it against its trigger; what changes is only
 * which subtree holds it.
 * @returns nothing; the effect is on the shared runtime's global component table.
 */
function registerContainedSelect(): void {
  const base = Vue.component(SELECT_ASSET)
  Vue.component(SELECT_ASSET, Vue.extend({
    name: SELECT_ASSET,
    extends: base,
    props: {
      popperAppendToBody: {
        type: Boolean,
        default: false,
      },
    },
  }))
}

/**
 * The autocomplete whose suggestions are drawn inside the block that owns it.
 *
 * The select's own registration above spells the reasoning out in full — a
 * popper the 2.15.14 mixin hands to `document.body` at the default is outside
 * the component entry `act_component` is confined to — and element-ui's
 * autocomplete draws its suggestion panel the same way, through the same
 * `popperAppendToBody` prop. A panel on the body would leave a `set` step able
 * to type into a suggestion field and reach none of its suggestions. The
 * subclass flips that default and registers over element-ui's own name, so
 * every `el-autocomplete` a kit draws keeps its panel inside the block
 * without any compiled markup changing.
 * @returns nothing; the effect is on the shared runtime's global component table.
 */
function registerContainedAutocomplete(): void {
  const base = Vue.component(AUTOCOMPLETE_ASSET)
  Vue.component(AUTOCOMPLETE_ASSET, Vue.extend({
    name: AUTOCOMPLETE_ASSET,
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
  registerContainedSelect()
  registerContainedAutocomplete()
}
