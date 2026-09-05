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
}
