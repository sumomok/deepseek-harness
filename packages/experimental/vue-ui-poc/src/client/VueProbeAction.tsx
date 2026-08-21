/**
 * The probe's React half: the slot entry the header renders.
 *
 * Everything framework-shaped stops here. The component resolves its slot
 * shares (the locale seat `t`) and owns the echo in React state, then hands
 * the Vue tree a flat record of strings, one number, and one callback. Nothing
 * below this file imports React, and nothing above it imports Vue.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the header action seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VueBridge } from './vue-bridge.tsx'
import { VueProbe } from './probe-component.ts'

/** Composed slot props: the header-action runtime share plus this plugin's locale seat. */
export type VueProbeActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'vuePoc'>

/**
 * Render the Vue probe in the session header.
 * @param props - composed slot props.
 * @returns the bridge host carrying the Vue tree.
 */
export function VueProbeAction({ t }: VueProbeActionProps) {
  const [echo, setEcho] = useState(0)
  return (
    <VueBridge
      component={VueProbe}
      props={{
        title: t('probe.title'),
        countLabel: t('probe.count'),
        echoLabel: t('probe.echo'),
        buttonLabel: t('probe.aria'),
        echo,
        onCount: setEcho,
      }}
    />
  )
}
