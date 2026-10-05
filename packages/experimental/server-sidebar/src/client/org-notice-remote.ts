/**
 * The organization plugin's notice Remote, connected to the notice card.
 *
 * The organization plugin's browser half mounts the namespace
 * {@link ORG_NOTICE_NAMESPACE} with three methods — `due()`,
 * `markSeen(version)`, and `confirm(version)` — whose Host half answers for
 * the member who called. {@link installOrgNotice} waits for that namespace's
 * service (`remote.<namespace>`) and only then registers the card in
 * `shell.overlay`, so a composition without the plugin, or with a plugin
 * that mounts no such namespace, shows no card and reports nothing. The
 * namespace is not in this package's `inject` list: the sidebar has to start
 * in a composition without the organization plugin.
 *
 * The namespace's methods answer the gateway's `RemoteResult` envelope;
 * {@link remotePort} unwraps it, turns a refusal into a rejection, and checks
 * each answer (`parseOrgNoticeDue`, `parseMarkSeenAnswer`,
 * `parseConfirmAnswer`). The card asks again when it mounts, when the
 * connection to the Host is established again (`connection/reset`), when the
 * page becomes visible again, and when the delay a `pending` answer names has
 * passed: nothing pushes a change, so a version the organization confirms
 * while the page is open shows at the next of these. Each kind of failure is
 * reported to the browser console once for the page.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/org-notice-remote
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls ui-layout's declaration of `shell.overlay`.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the connection plugin's `connection/reset` event.
import type {} from '@deepseek-ai/dsh-client-connection/client'
import {
  createOrgNoticeStore, isRecord, parseConfirmAnswer, parseMarkSeenAnswer, parseOrgNoticeDue, reportOncePerTopic,
  type OrgNoticePort, type OrgNoticeReport,
} from './org-notice.ts'
import { OrgNotice, type OrgNoticeInjected } from './OrgNotice.tsx'
import type { FootPlacement } from './foot-placement.ts'

/**
 * The organization plugin's Remote namespace for the notice, agreed with that
 * plugin and written here once.
 */
export const ORG_NOTICE_NAMESPACE = 'sumomokOrgNotice'

/** A refusal the plugin answered, carrying the gateway's code. */
export class OrgNoticeRefusal extends Error {
  /**
   * @param method - the method that was refused.
   * @param code - the refusal's code, when it carried one.
   * @param message - the refusal's message.
   */
  constructor(readonly method: string, readonly code: string | undefined, message: string) {
    super(`server-sidebar: ${ORG_NOTICE_NAMESPACE}.${method} was refused: ${message}`)
    this.name = 'OrgNoticeRefusal'
  }
}

/**
 * Unwrap one `RemoteResult` envelope.
 * @param method - the method that answered.
 * @param result - the envelope as the namespace resolved it.
 * @returns the answer's value.
 */
function unwrap(method: string, result: unknown): unknown {
  if (!isRecord(result) || typeof result.ok !== 'boolean') {
    throw new OrgNoticeRefusal(method, undefined, 'the answer is not a Remote result')
  }
  if (result.ok) return result.value
  const { error } = result
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : undefined
  const message = isRecord(error) && typeof error.message === 'string' ? error.message : 'no reason given'
  throw new OrgNoticeRefusal(method, code, message)
}

/**
 * Bind one of the namespace's methods.
 * @param namespace - the `remote.<namespace>` service.
 * @param method - the method's name.
 * @returns a call that unwraps the method's answer, or `undefined` when the namespace has no such method.
 */
function bindMethod(namespace: unknown, method: string): ((...args: unknown[]) => Promise<unknown>) | undefined {
  const call: unknown = isRecord(namespace) ? Reflect.get(namespace, method) : undefined
  if (typeof call !== 'function') return undefined
  return async (...args) => unwrap(method, await Reflect.apply(call, namespace, args))
}

/**
 * Adapt the namespace's service to the card's port.
 * @param namespace - the `remote.<namespace>` service.
 * @param report - where a `due()` answer of a `kind` the page does not know is reported.
 * @returns the port, or the name of the first of `due`, `markSeen`, and `confirm` the namespace lacks.
 */
export function remotePort(namespace: unknown, report: OrgNoticeReport): OrgNoticePort | { missing: string } {
  const due = bindMethod(namespace, 'due')
  if (due === undefined) return { missing: 'due' }
  const markSeen = bindMethod(namespace, 'markSeen')
  if (markSeen === undefined) return { missing: 'markSeen' }
  const confirm = bindMethod(namespace, 'confirm')
  if (confirm === undefined) return { missing: 'confirm' }
  const unknownKind = (kind: unknown): void => {
    report('kind', `server-sidebar: the organization notice answer has a kind the page does not know (${JSON.stringify(kind)}), so nothing is shown`)
  }
  return {
    due: async () => parseOrgNoticeDue(await due(), unknownKind),
    markSeen: async version => parseMarkSeenAnswer(await markSeen(version)),
    confirm: async version => parseConfirmAnswer(await confirm(version)),
  }
}

/**
 * Which of the two languages the card shows a disclosure's text in: Chinese
 * for a Chinese page, English for any other.
 * @param ctx - client root context.
 * @returns the language source.
 */
function disclosureLanguage(ctx: ClientContext): HostObservable<'zh' | 'en'> {
  return {
    getSnapshot: () => (ctx.locale.getSnapshot().active === 'zh' ? 'zh' : 'en'),
    subscribe: listener => ctx.locale.subscribe(listener),
  }
}

/**
 * Register the notice card once the organization plugin's namespace is
 * mounted, and ask it again on reconnection and on the page becoming visible.
 * @param ctx - client root context.
 * @param ns - this package's dictionary namespace.
 * @param footPlacement - where the sidebar's foot band is, for the card's wide-frame position.
 */
export function installOrgNotice(ctx: ClientContext, ns: 'serverSidebar', footPlacement: HostObservable<FootPlacement | undefined>): void {
  ctx.inject([`remote.${ORG_NOTICE_NAMESPACE}`], (org) => {
    const report = reportOncePerTopic((...line) => { console.warn(...line) })
    const port = remotePort(org.get(`remote.${ORG_NOTICE_NAMESPACE}`), report)
    if ('missing' in port) {
      console.warn(`server-sidebar: the organization notice namespace has no ${port.missing} method, so no notice is shown`)
      return
    }
    const store = createOrgNoticeStore(port, report)
    org.effect(() => () => { store.dispose() }, 'server-sidebar: organization notice asks')
    const refresh = (): void => { void store.refresh() }
    org.effect(() => org.slots.inject('shell.overlay', () => org.slots.register({
      name: 'shell.overlay',
      id: 'server-sidebar.org-notice',
      locale: ns,
      inject: (): OrgNoticeInjected => ({
        hooks: { orgNotice: store, footPlacement, language: disclosureLanguage(org) },
        acknowledge: store.acknowledge,
        later: store.later,
        consent: () => { void store.consent() },
      }),
    }, OrgNotice)), 'server-sidebar: organization notice')
    org.on('connection/reset', refresh)
    org.effect(() => {
      const onVisibility = (): void => {
        if (document.visibilityState === 'visible') refresh()
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => { document.removeEventListener('visibilitychange', onVisibility) }
    }, 'server-sidebar: organization notice on a visible page')
    refresh()
  })
}
