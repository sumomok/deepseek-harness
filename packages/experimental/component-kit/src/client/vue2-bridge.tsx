/**
 * Framework bridge: the React side of every Vue 2 component this row draws.
 *
 * Vue 2 has no standalone `render(vnode, container)`, so the bridge owns a Vue
 * root instance rather than a container. Four Vue 2 facts shape it:
 *
 * 1. `$mount(el)` REPLACES the element it is given, so the root is mounted onto
 *    a placeholder appended to the host. The host itself stays React's; its
 *    children belong to Vue.
 * 2. `$destroy()` tears the instance down without touching the DOM, so teardown
 *    removes `vm.$el` afterwards. Everything it needs is captured at mount:
 *    React clears refs before passive cleanups run.
 * 3. A Vue 2 root re-renders when reactive data changes, not when a parent asks
 *    it to. Both the prop record and the listener map therefore live in root
 *    properties, and assigning one patches the live tree in place while keeping
 *    the Vue-internal state of the component below it alive. Each is assigned
 *    only when the value behind it is a different object: the frozen record is
 *    the caller's own, so Vue's own setter drops a reassignment of the same one,
 *    while the listener map is a copy the bridge makes and therefore compares
 *    against the caller's for itself. A React commit that changed neither
 *    reaches Vue as nothing at all.
 * 4. element-ui's poppers are appended to `document.body`, outside the host, so
 *    hiding the host leaves them on screen. A placement package that keeps a
 *    block mounted while the user looks at something else passes
 *    `visible: false`, and the bridge closes what the component below opened.
 *
 * The `props` record is the whole contract between the two frameworks: the
 * React side resolves every framework hook and slot share before calling this,
 * so what crosses is plain data and callbacks — never a hook, a store handle, a
 * Cordis context, or a React node. `instanceRef` is the one thing that crosses
 * the other way, for the vendored components that answer through an instance
 * method rather than through an event.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/vue2-bridge
 */
import { useEffect, useRef, type MutableRefObject, type RefObject } from 'react'
import Vue, { type VueComponentOptions, type VueInstance } from './vue-shim.ts'
import { freezeDeep } from './freeze.ts'

/**
 * A prop record as Vue receives it. Vue's own `VNodeData.props` is an untyped
 * index signature, so a renderer declares its prop record as a `type` alias
 * rather than an `interface`: only the former carries the implicit index
 * signature this constraint needs.
 */
export type VuePropRecord = Readonly<Record<string, unknown>>

/**
 * What a Vue component's `$emit` reaches on the React side: one handler per
 * event name. Vue 2 event arguments are positional and carry no static type, so
 * `never[]` here means "any handler"; a handler declares the arguments its own
 * event carries.
 */
export type VueEventHandlers = Readonly<Record<string, (...args: never[]) => void>>

/**
 * The minimum of a Vue 2 instance the popper sweep walks: the component tree
 * and each node's declared name.
 */
interface VueNode {
  /** Child component instances, in creation order. */
  readonly $children: readonly VueNode[]
  /** The component's own options, of which only the name is read here. */
  readonly $options: { readonly name?: string }
}

/**
 * Component instances whose popper element escapes the host subtree, mapped to
 * the instance property that closes it.
 *
 * A closed table of the element-ui components a block may use: `el-dialog`,
 * `el-message`, and `el-notification` are forbidden outright, because nothing
 * here can close them. A further popper-bearing component used by a block must
 * be added here in the same change, or it stays on screen after the block it
 * belongs to is hidden — `el-date-picker` is here because the filter bar draws
 * one for an attribute whose values are dates.
 *
 * The sweep runs only for a caller that passes `visible: false`. No placement
 * package in this repository does: the content column unmounts a block that
 * leaves the screen, and element-ui's own `beforeDestroy` takes the popper off
 * the body with it. The table is what a placement that hides rather than drops
 * would need, and it is exercised against probe components rather than through
 * a seat.
 */
const POPPER_CLOSERS: ReadonlyMap<string, string> = new Map([
  ['ElSelect', 'visible'],
  ['ElTooltip', 'showPopper'],
  ['ElPopover', 'showPopper'],
  ['ElDatePicker', 'pickerVisible'],
])

/** The listener map a component with no events gets, kept stable across commits. */
const NO_HANDLERS: VueEventHandlers = Object.freeze({})

/** The bridge's Vue root: the two reactive properties every React commit reassigns. */
type VueBridgeRoot = VueInstance & {
  /** Current prop record, frozen; reassigning it is what patches the tree below. */
  p: VuePropRecord
  /** Current listener map, keyed by Vue event name: the bridge's copy of the caller's. */
  on: VueEventHandlers
}

/** What {@link useVueComponent} and {@link VueBridge} need to own one Vue root. */
export interface VueBridgeOptions {
  /**
   * The Vue 2 component to mount. Read once, at mount: the bridge owns one root
   * for its whole lifetime, so drawing a different component needs a different
   * React key rather than a new value here.
   */
  readonly component: VueComponentOptions
  /**
   * Complete prop set for that component: plain data and callbacks only. The
   * record and everything reachable from it is frozen in place before Vue sees
   * it, so a caller must already treat it as immutable.
   */
  readonly props: VuePropRecord
  /**
   * Handlers for the events the component emits; omitted when it emits none.
   *
   * Copied rather than frozen, which is the one place this bridge cannot use
   * the defense {@link props} gets: Vue 2 rewrites the listener object it is
   * given, replacing each handler with an invoker of its own, so a frozen map
   * throws where a frozen record is merely skipped. The copy is what Vue
   * observes and rewrites; the caller's own map is left as it was written.
   *
   * Its identity is what decides whether the root is patched, so a caller
   * writing the map inline re-renders the Vue tree on every React commit.
   */
  readonly on?: VueEventHandlers
  /**
   * Whether the block is on screen. `false` closes the poppers the component
   * opened outside the host; it does not hide the host, which stays the
   * placement package's own decision. Defaults to `true`.
   *
   * It is for a placement package that keeps a hidden block mounted. The one
   * placement package here unmounts instead, so nothing passes it today and the
   * popper sweep it turns on is covered by this module's own tests rather than
   * by a seat.
   */
  readonly visible?: boolean
  /**
   * Where the mounted component's own instance is published, for a renderer
   * that has to call a method on it.
   *
   * Some of the vendored components hand their data over through instance
   * methods rather than through an event — `TuQueryCondAdv.getData()` is the
   * one this exists for — and a few report a gesture with the rows deep-cloned,
   * so the identity a renderer reports by has to be read back off the instance.
   * The ref holds `root.$children[0]`, the component itself rather than the Vue
   * root this bridge owns, because the root is this module's own scaffolding
   * and its single child is the component the caller asked for.
   *
   * Read once, at mount, like {@link component}: the ref object a caller passes
   * on its first render is the one written to and cleared. It holds the
   * instance for exactly as long as the bridge is mounted, and `null` outside
   * that, so a renderer reads it only from an event handler or an effect.
   *
   * What comes back is a live Vue instance, and calling anything on it that
   * writes is reaching around the prop record the two frameworks agree on.
   * Renderers use it to read.
   */
  readonly instanceRef?: MutableRefObject<VueInstance | null>
}

/** Props of {@link VueBridge}. */
export type VueBridgeProps = VueBridgeOptions

/**
 * Own one Vue 2 root inside a host element React renders.
 *
 * Exposed alongside {@link VueBridge} for a renderer that needs a host element
 * of its own — one carrying the block's own attributes, or a sized container —
 * rather than the bare `span` that component renders.
 * @param options - the Vue component, its props, its listeners, and whether the block is on screen.
 * @returns the ref to attach to the host element; its children belong to Vue.
 */
export function useVueComponent<E extends HTMLElement = HTMLSpanElement>(
  options: VueBridgeOptions,
): RefObject<E> {
  const { component, props, on = NO_HANDLERS, visible = true, instanceRef } = options
  const hostRef = useRef<E>(null)
  const rootRef = useRef<VueBridgeRoot | null>(null)
  const handlersRef = useRef<VueEventHandlers | null>(null)

  // Mount-scoped: the host is captured while the ref still holds it, and the
  // root outlives every commit so the tree below keeps its own state. The
  // closure reads the first render's component and data, and records which
  // listener map its copy was made from, which is what the commit effect below
  // compares against.
  useEffect(() => {
    const host = hostRef.current as E
    const placeholder = document.createElement('div')
    host.appendChild(placeholder)
    const root = new Vue({
      data: () => ({ p: freezeDeep(props), on: { ...on } }),
      render(create) {
        const self = this as VueBridgeRoot
        return create(component, { props: self.p, on: self.on })
      },
    }) as VueBridgeRoot
    root.$mount(placeholder)
    rootRef.current = root
    handlersRef.current = on
    if (instanceRef !== undefined) instanceRef.current = root.$children[0] as VueInstance
    return () => {
      const mounted = root.$el
      root.$destroy()
      mounted.remove()
      rootRef.current = null
      handlersRef.current = null
      // React runs every passive cleanup of a commit before any of its passive
      // effects, so a caller remounting the bridge under a new key has this run
      // before the new mount publishes its own instance.
      if (instanceRef !== undefined) instanceRef.current = null
    }
  }, [])

  // Every commit, not just prop changes: the current values are what the root
  // has to be holding. The mount effect is declared first, so React has already
  // run it and the root exists on every commit including the first, which is
  // what the cast records.
  useEffect(() => {
    const root = rootRef.current as VueBridgeRoot
    root.p = freezeDeep(props)
    if (handlersRef.current === on) return
    handlersRef.current = on
    root.on = { ...on }
  })

  // Declared after the mount effect for the same reason, so a block that
  // arrives already hidden still has a root whose poppers can be closed.
  useEffect(() => {
    if (visible) return
    closePoppers(rootRef.current as VueBridgeRoot)
  }, [visible])

  return hostRef
}

/**
 * Mount `component` into a Vue root this bridge owns and keep it patched.
 * @param props - the Vue component, its props, its listeners, and whether the block is on screen.
 * @returns the host element React reconciles; its children belong to Vue.
 */
export function VueBridge(props: VueBridgeProps) {
  return <span ref={useVueComponent(props)} />
}

/**
 * Close every popper the tree under `root` opened outside the host.
 * @param root - the bridge's Vue root.
 */
function closePoppers(root: VueBridgeRoot): void {
  for (const instance of descendants(root)) {
    const property = POPPER_CLOSERS.get(instance.$options.name ?? '')
    if (property === undefined) continue
    ;(instance as unknown as Record<string, unknown>)[property] = false
  }
  // A focused el-select input reopens its dropdown on the next keystroke, so
  // the focus goes too — but only when it sits inside this bridge's own host.
  const active = document.activeElement
  if (active instanceof HTMLElement && root.$el.contains(active)) active.blur()
}

/**
 * Every component instance below `root`, root excluded.
 * @param root - the instance to walk down from.
 * @returns the descendants in depth-first order.
 */
function descendants(root: VueNode): readonly VueNode[] {
  return root.$children.flatMap(child => [child, ...descendants(child)])
}
