/**
 * The one Vue 2.7 runtime this row builds against.
 *
 * Vue 2 reactivity does not cross runtime copies: an observer, a `Dep`, and a
 * render watcher from one copy are invisible to another, so a component built
 * against a second copy stops updating with no error and no warning. This
 * package therefore takes `Vue` from the row that owns the only copy —
 * `@deepseek-ai/dsh-experimental-vue2-echarts-poc/client`, requested through
 * `dsh.client.external` and resolved by the loader's module table — instead of
 * importing `vue` for itself.
 *
 * The browser bundle maps the bare specifier `vue` onto this file
 * (`tsdown.config.ts`), so an inlined library's own `require('vue')` lands on
 * the shared runtime too. element-ui is the one inlined library that does that.
 * Neither vendored kit — `@sumomok/toy-surface-kit` nor `@sumomok/toy-crud-kit`
 * — imports `vue` or `element-ui`: their compiled components are option objects
 * that run on whatever runtime renders them and resolve their `el-*` tags
 * through the global registration `installElementUI()` performs. That is what
 * makes the function load-bearing rather than a convenience, and the crud kit
 * is what makes it load-bearing for a whole page: `Crud` is built out of `el-*`
 * tags and nothing else registers them.
 *
 * That alias is why **no file under `src/` may import `vue` itself**: an import
 * here would be aliased back onto this module and close a cycle.
 * `tests/source-vue-imports.client.spec.ts` pins the rule over the sources, and
 * `tests/client-bundle-vue.client.spec.ts` over the bundle they build into,
 * where a subpath the alias does not match would land a second runtime.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/vue-shim
 */
import { Vue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'

/**
 * Default export, because element-ui's CommonJS build reaches the runtime
 * through `_interopRequireDefault(require('vue'))`.
 */
export default Vue

/** One mounted Vue 2 instance of the shared runtime. */
export type VueInstance = InstanceType<typeof Vue>

/**
 * Anything `createElement` accepts as a component: an options object as
 * `@vitejs/plugin-vue2` emits one per SFC, a `defineComponent` result, a
 * constructor, or an async loader. The plain-element case is excluded, because
 * a bridge mounts a component rather than a tag name.
 *
 * Derived from the shared runtime's own `createElement` rather than imported
 * from `vue`, so this row still names one Vue and one only, and so the type
 * admits exactly what the render call below it does.
 */
export type VueComponentOptions =
  Exclude<NonNullable<Parameters<VueInstance['$createElement']>[0]>, string>
