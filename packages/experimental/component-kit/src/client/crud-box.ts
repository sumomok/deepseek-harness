/**
 * What every block drawing a component of the vendored `@sumomok/toy-crud-kit`
 * shares: waiting for the base path its requests go under, and mounting the
 * component inside a box the kit's request layer and toasts are contained in.
 *
 * Each of those components requests through the same `toy-core` layer — the
 * data page its scheme and rows, the form page its scheme and every save, the
 * info card its record — so each waits on the same read and is contained the
 * same way. The order is the whole point. The base path is applied by
 * `data-page-settings.ts` once the row's browser half has read it from the node
 * half, and a block mounts nothing until that read has settled, so no request
 * leaves under the kit's built-in default. Then `containCrud` marks the box the
 * component is mounted in, so the request layer's progress bar and overlay, and
 * the toasts a component raises, land inside that box rather than on the
 * document body; it runs from an effect declared before the bridge's mount
 * effect, which is what puts it before the component's first request. The
 * release is a second effect declared after the bridge's, because React runs
 * cleanups in declaration order and a component raises its last toasts while
 * Vue destroys it — the box has to outlive the component it contained.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/crud-box
 */
import { useEffect, useRef, useState, type RefObject } from 'react'
import { containCrud } from '@sumomok/toy-crud-kit'
import { dataPageBasePathReady } from './data-page-settings.ts'
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
  // Declared before the bridge's mount effect, so the box is contained before
  // the component is mounted and makes its first request.
  useEffect(() => { release.current = containCrud(box.current as HTMLDivElement) }, [])
  const host = useVueComponent<HTMLDivElement>(options)
  // Declared after the bridge's mount effect, so this cleanup runs after the
  // bridge's: released in the effect that contained the box, the box would
  // stop being a box before the component's last toasts were raised, and they
  // would land on the document body with nothing to adopt them. The release is
  // set by the effect declared before this one, which is why it is there by
  // the time this cleanup runs.
  useEffect(() => () => { (release.current as () => void)() }, [])
  return { box, host }
}
