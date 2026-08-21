/**
 * Vue-in-React proof of concept, browser half: contributes one entry to
 * `conversation.session.header.actions` whose body is a Vue 3 component.
 *
 * Vue is not in the shell's shared module table, so this package's bundle
 * carries its own Vue runtime — the ordinary treatment for a third-party
 * library (see the package README for what that costs). The plugin itself is
 * an ordinary slot registrant: no host RPC, no store, no state outside the
 * component it registers.
 * @module @deepseek-ai/dsh-experimental-vue-ui-poc/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the header action seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VueProbeAction } from './VueProbeAction.tsx'
import { en, NS, zh, type VuePocKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Vue probe's copy. */
    vuePoc: VuePocKey
  }
}

export type { VueProbeActionProps } from './VueProbeAction.tsx'

/** Required services: the header slot's registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header entry.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vue-ui-poc: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'vue-ui-poc',
      // After every shipped action: a probe must not displace product controls.
      order: 100,
      locale: NS,
    }, VueProbeAction),
  )
}
