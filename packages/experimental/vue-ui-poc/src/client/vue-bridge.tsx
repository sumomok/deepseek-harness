/**
 * Framework bridge: one React component that owns a Vue render root.
 *
 * The slot system accepts React function components only, so a Vue feature
 * reaches a slot by being wrapped here. The bridge uses Vue's low-level
 * `render(vnode, container)` rather than `createApp`, because an app instance
 * carries its own plugin/provide/config realm that would be created and thrown
 * away on every React commit; `render` targets the same container repeatedly
 * and diffs, which is what keeps the Vue tree's reactive state alive across
 * React re-renders.
 *
 * The `props` object is the whole contract between the two frameworks: the
 * React side resolves every framework hook and slot share before calling this,
 * so what crosses is plain data and callbacks — never a hook, a store handle,
 * a Cordis context, or a React node.
 */
import { useEffect, useRef } from 'react'
import { h, render, type Component } from 'vue'

/** Props of {@link VueBridge}. */
export interface VueBridgeProps<P extends object> {
  /** The Vue component to mount; identity is stable for the bridge's lifetime. */
  readonly component: Component<P>
  /** Complete prop set for that component: plain data and callbacks only. */
  readonly props: P
}

/**
 * Mount `component` into a container this bridge owns and keep it patched.
 * @param bridgeProps - the Vue component and its complete prop set.
 * @returns the host element React reconciles; its children belong to Vue.
 */
export function VueBridge<P extends object>({ component, props }: VueBridgeProps<P>) {
  const hostRef = useRef<HTMLSpanElement>(null)

  // Every commit, not just prop changes: `render` diffs the new vnode against
  // the tree already in the container, so an unchanged prop set costs one
  // patch pass and a changed one updates in place. React has attached the ref
  // by the time any effect runs, which is what the cast records.
  useEffect(() => {
    render(h(component as Component, { ...props }), hostRef.current as HTMLSpanElement)
  })

  // Teardown is mount-scoped so the container is captured while the ref still
  // holds it: React clears refs before passive cleanups run, and Vue needs the
  // element to unmount its tree and fire its own lifecycle hooks.
  useEffect(() => {
    const host = hostRef.current as HTMLSpanElement
    return () => { render(null, host) }
  }, [])

  return <span ref={hostRef} />
}
