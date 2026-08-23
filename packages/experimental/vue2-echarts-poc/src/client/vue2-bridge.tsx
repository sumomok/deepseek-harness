/**
 * Framework bridge: one React component that owns a Vue 2.7 render root.
 *
 * Vue 2 has no standalone `render(vnode, container)`, so the bridge owns a Vue
 * root instance instead of a container. Three Vue 2 facts shape it:
 *
 * 1. `$mount(el)` REPLACES the element it is given, so the root is mounted onto
 *    a placeholder appended to the host. The host itself stays React's; its
 *    children belong to Vue.
 * 2. `$destroy()` tears the instance down without touching the DOM, so teardown
 *    removes `vm.$el` afterwards. Everything it needs is captured at mount:
 *    React clears refs before passive cleanups run.
 * 3. A Vue 2 root re-renders when reactive data changes, not when a parent asks
 *    it to. The whole prop record therefore lives in one reactive root property,
 *    and every React commit reassigns it — which patches the live tree in place
 *    and keeps the Vue-internal state of the component below it alive.
 *
 * The `props` object is the whole contract between the two frameworks: the
 * React side resolves every framework hook and slot share before calling this,
 * so what crosses is plain data and callbacks — never a hook, a store handle, a
 * Cordis context, or a React node. The record is copied and frozen on the way
 * in, so Vue's observer walks nothing React owns (an observed array has its
 * prototype swapped, which would reach back into React's data).
 */
import { useEffect, useRef } from 'react'
import Vue, { type Component } from 'vue'

// The probe renders no template and runs no devtools bridge; both notices are
// pure console noise in a browser that already loaded the harness shell.
Vue.config.productionTip = false
Vue.config.devtools = false

/** The bridge's Vue root: one reactive property holding the current prop record. */
interface Vue2Root<P extends object> extends Vue {
  /** Current prop record; reassigning it is what patches the tree below. */
  p: P
}

/** Props of {@link Vue2Bridge}. */
export interface Vue2BridgeProps<P extends object> {
  /** The Vue 2 component to mount; identity is stable for the bridge's lifetime. */
  readonly component: Component
  /** Complete prop set for that component: plain data and callbacks only. */
  readonly props: P
}

/**
 * Mount `component` into a Vue root this bridge owns and keep it patched.
 * @param bridgeProps - the Vue component and its complete prop set.
 * @returns the host element React reconciles; its children belong to Vue.
 */
export function Vue2Bridge<P extends object>({ component, props }: Vue2BridgeProps<P>) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const rootRef = useRef<Vue2Root<P> | null>(null)

  // Mount-scoped: the host is captured while the ref still holds it, and the
  // root outlives every commit so the tree below keeps its own state.
  useEffect(() => {
    const host = hostRef.current as HTMLSpanElement
    const placeholder = document.createElement('div')
    host.appendChild(placeholder)
    const root = new Vue({
      data: () => ({ p: Object.freeze({ ...props }) }),
      render(create) { return create(component, { props: (this as Vue2Root<P>).p }) },
    }) as Vue2Root<P>
    root.$mount(placeholder)
    rootRef.current = root
    return () => {
      const mounted = root.$el
      root.$destroy()
      mounted.remove()
      rootRef.current = null
    }
  }, [])

  // Every commit, not just prop changes: reassigning the reactive record makes
  // Vue diff the tree it already rendered. The mount effect is declared first,
  // so React has already run it and the root exists on every commit including
  // the first, which is what the cast records.
  useEffect(() => {
    ;(rootRef.current as Vue2Root<P>).p = Object.freeze({ ...props })
  })

  return <span ref={hostRef} />
}
