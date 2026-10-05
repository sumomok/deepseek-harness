/**
 * The settings shell's section opener, for the identity row's menu.
 *
 * The console's settings shell (`dsh-client-ui-settings-general`) hands its
 * `openSection(id)` only to the occupants of `settings.trigger.action`, the
 * list it renders beside the settings trigger. The sidebar draws that trigger
 * in its compact form (`wide: false`), where the shell hides the list with
 * CSS but keeps its occupants mounted. {@link SettingsOpenerSeat} is one such
 * occupant: it renders nothing and publishes the opener it receives into a
 * {@link SettingsOpenerSource}, which the sidebar reads through its inject
 * face's `hooks.settingsOpener`. The source holds `undefined` until the seat
 * first mounts and again after it unmounts, which is whenever the settings
 * shell is not mounted.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/settings-opener
 */
import { useEffect } from 'react'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-settings' declaration of `settings.trigger.action`.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

/**
 * Open the settings panel on one section.
 * @param id - the `settings.section` id to activate; an id no section claims
 * opens the panel on its first row.
 */
export type SettingsOpener = (id: string) => void

/** The opener the seat last published, observable by the sidebar. */
export interface SettingsOpenerSource extends HostObservable<SettingsOpener | undefined> {
  /**
   * Record the opener the seat holds now, notifying subscribers when it is a
   * different function from the one recorded.
   * @param opener - the shell's opener, or `undefined` once the seat unmounts.
   */
  publish(opener: SettingsOpener | undefined): void
}

/**
 * Create an empty source.
 * @returns the source, holding `undefined` until the first publish.
 */
export function createSettingsOpenerSource(): SettingsOpenerSource {
  let current: SettingsOpener | undefined
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    publish: (opener) => {
      if (Object.is(opener, current)) return
      current = opener
      for (const listener of [...listeners]) listener()
    },
  }
}

/** The seat's injected face: where it publishes the opener it receives. */
export interface SettingsOpenerSeatInjected {
  /** {@link SettingsOpenerSource.publish} of the sidebar's source. */
  publish: SettingsOpenerSource['publish']
}

/** The seat's props: the owner's opener and its injected face. */
export type SettingsOpenerSeatProps = Pick<PropsRuntime<'settings.trigger.action'>, 'openSection'> & InjectFace<SettingsOpenerSeatInjected>

/**
 * Publish the shell's opener while mounted, and withdraw it on unmount.
 * @param props - the owner's `openSection` and the injected `publish`.
 * @returns nothing; the seat draws no element.
 */
export function SettingsOpenerSeat({ openSection, publish }: SettingsOpenerSeatProps): null {
  useEffect(() => {
    publish(openSection)
    return () => { publish(undefined) }
  }, [openSection, publish])
  return null
}
