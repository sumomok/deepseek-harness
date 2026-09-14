/** Register the Chat Conversation target, renderers, stats, and details surface. */
import type { Context } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ISessions, ReferentRef, SessionBinding,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { MarkdownProseReferents } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// The `file` entry of `SidebarRightResourceParamsMap`, which types `{ params: { line } }` below.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { fileAddressFor, resolveWorkspacePath } from '@deepseek-ai/dsh-util-workspace-path'
// Type-only service and declaration merges used by the apply world.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {
  ChatNodeTurnDataInjected, ChatScrollPosition, ChatViewInjected,
  ProseReferentSpan, TurnTailOwnerProps,
} from './contract/slots.ts'
import type { ChatSnapshot } from './contract/snapshot.ts'
import { EMPTY_CHAT_SNAPSHOT } from './contract/snapshot.ts'
import { ApprovalCommand } from './chat/ApprovalCommand.tsx'
import { ChatView } from './chat/ChatView.tsx'
import { registerChatNodeRenderers } from './chat/register-node-renderers.ts'
import { StatsPills } from './chat/StatsPills.tsx'
import { registerConversationNodes } from './conversation-nodes/register.ts'
import { en, NS, zh } from './locale.ts'
import { TranscriptViewRow, type TranscriptViewRowInjected } from './settings/TranscriptViewRow.tsx'
import { createChatStore } from './stores.ts'
import { TranscriptViewPolicy } from './transcript-view.ts'
import { CHAT_SETTINGS_NAMESPACE, type ChatSettings } from '../chat-settings.ts'
import { useTurnDataValue } from './chat/use-turn-data.ts'

const CHAT_NODE_INJECT: ChatNodeTurnDataInjected = {
  hooks: {
    turnData: (_standard, data) => function useTurnData(key) {
      return useTurnDataValue(data, key)
    },
  },
}

/** Services required by the Chat target and its presentation registrations. */
export const inject = [
  'connection', 'slots', 'sessions', 'referent', 'uiSession', 'uiConversation', 'conversation', 'locale',
  'settingsScope', 'remote', 'remote.session', 'sidebarRight',
]

/**
 * Build the render-facing prose-referent scanner/opener for one session, or
 * undefined when no {@link ProseReferents} provider is composed in.
 * `scan` reads the session cwd and Host account home fresh on every call
 * (the same lazy-read technique `openFile` below uses for cwd), so composing
 * the provider in or out, or a workspace change, takes effect on the very
 * next render with no re-registration.
 * @param ctx - client root context.
 * @param sessions - resolved once by the caller, mirroring the other apply-time service reads below.
 * @param connection - resolved once by the caller; its `generation` snapshot names the Host account home.
 * @param sessionId - the session this scanner/opener is bound to.
 * @param notifyNotFound - surface the session's own composer notice for a
 * `session/path-not-found` open failure (bound by the caller to
 * `actx.conversation.input.for(actx).notify('error', …)`); kept as a plain
 * callback rather than threading the session scope itself through, so this
 * function stays testable with a bare stub.
 * @param notFoundText - localized notice text for that case, resolved once
 * by the caller (the same lazy-bind-then-call-per-render pattern the rest of
 * this module's `t(...)` call sites use).
 * @returns the scanner/opener MarkdownText consumes, or undefined.
 */
function buildProseReferents(
  ctx: Context, sessions: ISessions, connection: ConnectionHandle, sessionId: SessionId,
  notifyNotFound: (sessionId: SessionId, text: string) => void, notFoundText: string,
): MarkdownProseReferents | undefined {
  const provider = ctx.get('proseReferents')
  if (provider === undefined) return undefined
  // ProseReferents' optional methods are plain callback properties, not
  // `this`-bound instance methods; extracting them here is what lets
  // TypeScript narrow "defined" through the conditional spreads below and
  // into their closures.
  // oxlint-disable-next-line typescript/unbound-method
  const { resolveLink: providerResolveLink, subscribe: providerSubscribe } = provider
  return {
    scan: (text, inlineCode) => provider.scan(text, {
      cwd: sessions.list.getSnapshot().byId[sessionId]?.cwd,
      home: connection.generation.getSnapshot()?.host.home,
      inlineCode,
    }),
    // exactOptionalPropertyTypes: an optional method is either present or
    // absent from the object, never present-with-value-undefined — the
    // conditional spreads below are what that distinction requires.
    ...(providerResolveLink === undefined ? {} : {
      resolveLink: (destination: string, displayText: string) => providerResolveLink(destination, displayText, {
        cwd: sessions.list.getSnapshot().byId[sessionId]?.cwd,
        home: connection.generation.getSnapshot()?.host.home,
      }),
    }),
    ...(providerSubscribe === undefined ? {} : {
      subscribe: (listener: () => void) => providerSubscribe(listener),
    }),
    open: (span) => {
      // Safe: this scanner's own `scan` above is the only producer of spans
      // MarkdownText ever hands back to `open` — it treats a span as opaque
      // (start/end only) and returns the exact object `scan` gave it, which
      // always carries the fuller ProseReferentSpan shape at runtime.
      const referentSpan = span as ProseReferentSpan
      const ref: ReferentRef = {
        kind: referentSpan.kind,
        target: referentSpan.target,
        raw: referentSpan.raw,
        sessionId,
        // Never the openFile chokepoint's own ref below: that would
        // double-dispatch this click and mislabel its provenance as
        // 'structured' — this click is model-authored prose, not a
        // structured content-part open.
        source: 'chat-prose',
        provenance: 'model-text',
      }
      const onDefault = async (): Promise<void> => {
        if (referentSpan.kind === 'url') {
          window.open(referentSpan.target, '_blank', 'noopener,noreferrer')
          return
        }
        // The openFile chokepoint below hands its path to the right Sidebar;
        // a prose referent instead reaches the Host path opener, and the raw
        // RemoteError is rethrown (not flattened to a message-only Error) so
        // the .catch below can classify a not-found race by `.code`.
        const result = await ctx.remote.session.openWorkspacePath({ path: referentSpan.target })
        if (!result.ok) throw result.error
      }
      // `session/path-not-found` gets the same downgrade the terminal card
      // already has for the identical race: a span the verification layer
      // confirmed can still name a path deleted between that `stat` and this
      // click. Prose spans have no per-span notice slot of their own — a
      // `fileMention` button is a pure render of `scan`/`resolveLink`'s
      // output (`ui-primitives`'s `render.tsx`), not a stateful component —
      // so this reuses the session's own composer notice channel instead.
      // Any other failure still only reaches the console: no dedicated UI
      // for those yet (unlike openFile's dialog below).
      void ctx.referent.open(ref, onDefault).catch((error: unknown) => {
        if (remoteErrorOf(error)?.code === 'session/path-not-found') {
          notifyNotFound(sessionId, notFoundText)
          return
        }
        console.error('ui-chat: chat-prose referent open failed', error)
      })
    },
  }
}

/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  const chatSources = new WeakMap<SessionBinding, ObservableSnapshot<ChatSnapshot>>()
  const chatSource = (binding: SessionBinding): ObservableSnapshot<ChatSnapshot> => {
    let source = chatSources.get(binding)
    if (source === undefined) {
      const target = ctx.uiConversation.binding(binding).target('chat')
      source = {
        getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
        subscribe: listener => target.subscribe(listener),
      }
      chatSources.set(binding, source)
    }
    return source
  }
  registerConversationNodes(ctx)
  registerChatNodeRenderers(ctx)
  ctx.uiSession.provide({
    hooks: ['chat'],
    resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries')
  const t = ctx.locale.bind(NS)
  const chatStore = createChatStore()
  const chatScrollPositions = new Map<SessionId, ChatScrollPosition>()
  const transcriptView = new TranscriptViewPolicy(
    ctx.settingsScope.bind<ChatSettings>({ namespace: CHAT_SETTINGS_NAMESPACE }),
  )

  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'transcript-view',
    order: 12,
    locale: NS,
    inject: (): TranscriptViewRowInjected => ({
      hooks: { transcriptView: transcriptView.mode },
      setTranscriptView: (mode) => { transcriptView.setMode(mode) },
    }),
  }, TranscriptViewRow))

  ctx.slots.inject('conversation.view', () => {
    const disposeView = ctx.slots.register({
      name: 'conversation.view',
      id: 'chat',
      order: 0,
      label: () => t('view.chat'),
      locale: NS,
      children: {
        'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
        'conversation.message.images': { kind: 'single', scope: 'session' },
        'conversation.chat.user-actions': { kind: 'list', scope: 'session' },
      },
      store: chatStore,
      inject: (sessionId: SessionId): ChatViewInjected => {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) throw new Error(`ui-chat: unknown session "${sessionId}"`)
        const session = binding.session
        const chat = chatSource(binding)
        return {
          hooks: { transcriptView: transcriptView.mode },
          keyedHooks: {
            chatNode: key => chat.getSnapshot().nodes.source(key),
            chatNodeProcess: key => chat.getSnapshot().nodes.processSource(key),
          },
          fileMentions: (owner: TurnTailOwnerProps) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId),
          referents: buildProseReferents(
            ctx, ctx.sessions, connection, sessionId,
            (id, text) => {
              const actx = ctx.sessions.scope(id)
              // .get(), not the direct-property accessor: actx is a session
              // scope this plugin's own `inject` guard does not cover, even
              // though 'conversation' is declared above as a real dependency.
              const conversation = actx?.get('conversation')
              if (actx !== undefined && conversation !== undefined) conversation.input.for(actx).notify('error', text)
            },
            t('referent.notFound'),
          ),
          // referent/open first: wraps the pre-existing open action as the
          // waterfall's terminus, so every consumer this one closure already
          // reaches (tool rows, produced-file chips, and mentions) becomes
          // interceptable without a per-consumer change. Zero listeners exist
          // yet: with none registered the waterfall reaches its terminus
          // immediately and this call is byte-identical to the un-wrapped open
          // it replaces.
          //
          // Files open in the right Sidebar, not in a desktop application: the
          // content stays in the product, beside the conversation that produced
          // it. A relative path, or an absolute one inside the session's
          // workspace, is addressed under this session's scope,
          // `dsh-resource://file/session/<id>/<path>`; an absolute path
          // elsewhere keeps its absolute spelling in the same Session's address.
          // Which tab type claims the
          // address is the Sidebar's decision, not this call site's.
          // A line travels as a navigation parameter, not as part of the
          // address: the file is one piece of content whether it is opened at
          // its top or at line 400, so the same tab is revealed and told where
          // to land.
          openFile: async (path, options) => {
            const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd
            const ref: ReferentRef = {
              // ProducedFiles opens the session workspace root as '.'; every
              // other path this closure ever receives names a file (no
              // richer file/dir signal reaches this closure).
              kind: path === '.' ? 'dir' : 'file',
              target: resolveWorkspacePath(cwd, path),
              raw: path,
              sessionId,
              source: 'chat-view.openFile',
              provenance: 'structured',
            }
            await ctx.referent.open(ref, async () => {
              const url = fileAddressFor(sessionId, cwd, path)
              if (options?.line === undefined) ctx.sidebarRight.openResource(url)
              else ctx.sidebarRight.openResource(url, { params: { line: options.line } })
              await Promise.resolve()
            })
          },
          openSkill: (name) => {
            const scope = ctx.sessions.scope(sessionId)
            if (scope === undefined) return
            ctx.get('inputTriggers')?.sessionOf(scope).openReference('skill', { ref: `/${name}` })
          },
          loadOlder: () => { void session.loadOlder() },
          loadThrough: seq => session.loadThrough(seq),
          loadImage: Object.assign(
            (attachment: ImageAttachmentRef) => ctx.uiConversation.imageUrl(sessionId, attachment),
            { peek: (attachment: ImageAttachmentRef) => ctx.uiConversation.peekImageUrl(sessionId, attachment) },
          ),
          chatScroll: {
            save: (position) => {
              if (position === null) chatScrollPositions.delete(sessionId)
              else chatScrollPositions.set(sessionId, position)
            },
            read: () => chatScrollPositions.get(sessionId) ?? null,
          },
          forkAt: (seq) => {
            ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
              .then((childId) => { ctx.sessions.open(childId) })
              .catch(() => {
                // Fork or child-title failure leaves the source view unchanged.
              })
          },
        }
      },
    }, ChatView)
    return disposeView
  })

  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register({
      name: 'conversation.composer.dock',
      id: 'stats',
      order: 0,
      locale: NS,
      children: {
        'conversation.chat.stats.usageLabel': { kind: 'single', scope: 'session' },
        'conversation.chat.stats.usageRows': { kind: 'list', scope: 'session' },
      },
    }, StatsPills))

  // The shell family is this package's key domain here: `bash` and `pwsh` are
  // the wire names of both the one-shot and the persistent shells, and their
  // arguments are the only ones this renderer reads.
  ctx.slots.inject('conversation.approval.detail', function* () {
    yield ctx.slots.register({ name: 'conversation.approval.detail', key: 'bash' }, ApprovalCommand)
    yield ctx.slots.register({ name: 'conversation.approval.detail', key: 'pwsh' }, ApprovalCommand)
  })

}
