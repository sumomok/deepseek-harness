/**
 * What every block drawing a component of the vendored `@sumomok/toy-crud-kit`
 * shares: waiting for the base path its requests go under, mounting the
 * component inside a box the kit's request layer and toasts are contained in,
 * and reporting a gesture once per placing call.
 *
 * Each of those components requests through the same `toy-core` layer, so each
 * mounts nothing until `data-page-settings.ts` has applied the base path the
 * row's browser half read from the node half, and no request leaves under the
 * kit's built-in default. `containCrud` then marks the box the component is
 * mounted in, so the request layer's progress bar and overlay, and the toasts a
 * component raises, land inside that box rather than on the document body. The
 * box is contained before the component's first request and released only
 * after Vue has destroyed the component, which raises its last toasts while it
 * goes.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/crud-box
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { containCrud } from '@sumomok/toy-crud-kit'
import { dataPageBasePathReady } from './data-page-settings.ts'
import type { ComponentActionHandler } from './renderer.ts'
import { useVueComponent, type VueBridgeOptions } from './vue2-bridge.tsx'

/** Whether the base path the kit's requests go under has been applied. */
export type BasePathState = 'waiting' | 'ready' | 'failed'

/**
 * Follow the one read of the base path the kit's requests go under.
 * @returns `waiting` until the read settles, then `ready` or `failed`.
 */
export function useBasePathState(): BasePathState {
  const [state, setState] = useState<BasePathState>('waiting')
  useEffect(() => {
    let mounted = true
    dataPageBasePathReady().then(
      () => { if (mounted) setState('ready') },
      () => { if (mounted) setState('failed') },
    )
    return () => { mounted = false }
  }, [])
  return state
}

/** The two elements one contained component is drawn into. */
export interface ContainedComponent {
  /** The box: the positioned ancestor the kit's overlay, progress bar and toasts are confined to. */
  readonly box: RefObject<HTMLDivElement>
  /** The host the bridge mounts the component under, inside the box. */
  readonly host: RefObject<HTMLDivElement>
}

/**
 * Mount one kit component inside a contained box.
 *
 * The caller draws `host` inside `box` and mounts the pair only once the base
 * path is in force; the box is contained before the component's first request
 * and released only after the component is destroyed.
 * @param options - the component, its props and its listeners, as the bridge takes them.
 * @returns the box and the host to attach.
 */
export function useContainedComponent(options: VueBridgeOptions): ContainedComponent {
  const box = useRef<HTMLDivElement>(null)
  const release = useRef<() => void>()
  // React runs effects and their cleanups in declaration order: contained
  // before the bridge mounts the component, released after it destroys it.
  useEffect(() => { release.current = containCrud(box.current as HTMLDivElement) }, [])
  const host = useVueComponent<HTMLDivElement>(options)
  useEffect(() => () => { (release.current as () => void)() }, [])
  return { box, host }
}

/**
 * The last report each placing call's block made under each of its slots,
 * serialized. Keyed by the block's property record, which the placement
 * package hands over unchanged for the life of one call and replaces for the
 * next: a block the column dropped and drew again finds what it said before,
 * and a later call under the same ids starts with nothing reported.
 */
const REPORTED = new WeakMap<Readonly<Record<string, unknown>>, Map<string, string>>()

/**
 * Report one gesture unless this placing call's block last reported the same
 * one under the same slot.
 * @param props - the block's property record.
 * @param slot - which of the block's remembered reports this one replaces.
 * @param actionId - the action to report.
 * @param payload - what to report.
 * @param onAction - where it goes.
 */
export function reportOnce(
  props: Readonly<Record<string, unknown>>,
  slot: string,
  actionId: string,
  payload: Readonly<Record<string, unknown>>,
  onAction: ComponentActionHandler,
): void {
  let held = REPORTED.get(props)
  if (held === undefined) {
    held = new Map()
    REPORTED.set(props, held)
  }
  const signature = JSON.stringify([actionId, payload])
  if (held.get(slot) === signature) return
  held.set(slot, signature)
  onAction(actionId, payload)
}
