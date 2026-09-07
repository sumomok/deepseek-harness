/** Chat-owned Slot declarations and composed component props. */
import type { ReactNode } from 'react'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ReferentKind } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'
import type {
  CommandNode, CompactionSummaryNode, ConversationLocationDataStore, ConversationTurnDataMap,
  MessageImageLoader, MessageImagesOwnerProps, RenderMessageImages, ToolCallBlock, TurnLocation,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  InjectFace, KeyedSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime, PropsStore,
  SlotHookFactory, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarkdownFileMentions, MarkdownProseReferents } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { createChatStore } from '../stores.ts'
import type { ToolCallId, SelectionTarget } from './store.ts'
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type {
  ChatNodeProcessSource, ChatNodeSource, ChatSnapshot, ChatTurnProcessPresentation,
} from './snapshot.ts'
import type { TurnProcessSpec } from './turn-process.ts'
import type { TranscriptViewMode } from '../../chat-settings.ts'

/** Selector hook over the current Conversation binding's Chat target. */
export type UseChat = SnapshotSelectorHook<ChatSnapshot>

/** Per-key selector hook over one Chat Node. */
export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>

/** Per-key selector hook over one Chat Node's Turn-process presentation. */
export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>

/** Owner currency of the completed-Turn extension chain. */
export interface TurnTailOwnerProps {
  turn: TurnLocation
  seq: number
  openFile: (path: string) => void
}

/** Owner currency of finalized-assistant actions. */
export interface AssistantActionOwnerProps {
  messageId: MessageId
}

/**
 * Owner currency of the user-message action strip: where the addressed message
 * sits in the durable log, plus the text its bubble rendered. A user message
 * carries no message id — `messageId` is the assistant-side identity space —
 * so `seq` addresses it.
 */
export interface UserActionOwnerProps {
  /** Log position of the `user/message` event this strip addresses. */
  seq: number
  /** The message's joined text, the same string the built-in copy action writes. */
  text: string
}

/** Slot-backed renderer for the actions one user-side message offers. */
export type RenderUserActions = (owner: UserActionOwnerProps) => ReactNode

/** Optional prose file-mention provider consumed by Chat. */
export interface ChatFileMentions {
  /**
   * Resolve prose links for one closing Turn.
   * @param owner - closing-Turn identity and file opener.
   * @returns link resolver when available.
   */
  forClosing(owner: TurnTailOwnerProps): MarkdownFileMentions | undefined
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional prose file-mention provider. */
    chatFileMentions: ChatFileMentions
  }
}

/**
 * One clickable reference a {@link ProseReferents} scan found in a rendered
 * text run.
 */
export interface ProseReferentSpan {
  /** Start offset into the scanned text, inclusive. */
  readonly start: number
  /** End offset into the scanned text, exclusive. */
  readonly end: number
  /** Open target's kind; see {@link ReferentKind}. */
  readonly kind: ReferentKind
  /** Resolved target the default open action acts on (an absolute path for `file`/`dir`, a URL string for `url`). */
  readonly target: string
  /** The raw text exactly as it appeared at the span's source, before resolution. */
  readonly raw: string
}

/**
 * Optional prose-referent scanning provider, consumed via
 * `ctx.get('proseReferents')` (optional-service convention, mirrors
 * {@link ChatFileMentions}): the chat view asks it to scan a rendered text
 * run — plain prose or inline code — for clickable references and threads
 * the result into MarkdownText. Absent service — the providing plugin
 * composed out of cordis.yml — turns the surface off; prose and inline code
 * render exactly as they did before this seam existed.
 *
 * Three-layer invariant (nominate → verify → open): a span this interface
 * ever hands back to the renderer is, by construction, already verified —
 * unverified candidates never leave the provider. `scan` and `resolveLink`
 * both hold to this; only a session truth index hit or a host `stat` may
 * promote a candidate to a returned span.
 */
export interface ProseReferents {
  /**
   * Scan one rendered text run and return only its **verified** clickable
   * spans — unverified candidates stay out of the return value entirely, so
   * "blue = openable" holds structurally: no unverified data ever reaches
   * the renderer. Pure and synchronous: no IO, no filesystem `stat` runs
   * here — verification against the session truth index or a prior `stat`
   * result is a cache read, never a fresh probe.
   * @param text - Exact text content of the node being rendered.
   * @param context - `cwd`/`home` resolve a relative candidate (undefined
   * wherever the session/workspace has none — the provider decides whether
   * that suppresses a span or not); `inlineCode` is true for an inline-code
   * token, false for plain prose text.
   * @returns Non-overlapping, verified spans in ascending `start` order.
   */
  scan(
    text: string,
    context: { cwd?: string | undefined; home?: string | undefined; inlineCode: boolean },
  ): readonly ProseReferentSpan[]
  /**
   * Nominate a non-web-scheme markdown link destination (a local path shape
   * the renderer itself detected — see `render.tsx`'s link handling) and
   * return its verified span, or `undefined` to keep the link inert. Pure
   * and synchronous, same verified-only contract as {@link scan}: a defined
   * return is already verified, never a fresh probe.
   * @param destination - The link's decoded destination text.
   * @param displayText - The link's rendered text, for a provider that logs
   * or disambiguates by what the reader actually sees.
   * @param context - `cwd`/`home` resolve a relative destination, as in {@link scan}.
   * @returns The verified span, or `undefined` when the destination is not
   * (yet, or ever) verified — the renderer then keeps the link inert.
   */
  resolveLink?(
    destination: string,
    displayText: string,
    context: { cwd?: string | undefined; home?: string | undefined },
  ): ProseReferentSpan | undefined
  /**
   * Subscribe to verification progress: called once a batch of pending
   * candidates finishes its host `stat` round, so a host that already
   * rendered unverified-as-plain-text spans can re-scan and reveal whatever
   * just verified. Optional — a provider with no asynchronous verification
   * (everything decided synchronously in `scan`/`resolveLink`) omits it.
   * @param listener - Called with no arguments after each verification tick.
   * @returns Unsubscribe function.
   */
  subscribe?(listener: () => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Prose-referent scanning provider (e.g. clickable-refs); reach via ctx.get — optional. */
    proseReferents: ProseReferents
  }
}

/** Hook constrained to business data published on the current Chat Node's Turn. */
export type UseChatNodeTurnData = <Key extends Extract<keyof ConversationTurnDataMap, string>>(
  key: Key,
) => Readonly<ConversationTurnDataMap[Key]> | undefined

/** Slot-level Hook factory for keyed Chat renderers. */
export interface ChatNodeTurnDataInjected {
  hooks: { turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData> }
}

/** Stable owner currency delivered to a keyed Chat renderer. */
export interface ChatNodeOwnerProps {
  selectedCallId?: ToolCallId | undefined
  cwd?: string | undefined
  openFile: (path: string) => void
  inspectCall: (callId: ToolCallId) => void
  forkAt: (seq: number) => void
  /**
   * Session-authorized image loader, down-threaded from the Chat view so a
   * chat-node renderer can render the attachment presentation slot directly
   * with only the durable references plus this loader, instead of receiving a
   * rendering closure.
   */
  loadImage: MessageImageLoader
  renderMessageImages: RenderMessageImages
  /**
   * Render the contributed actions of one user-side message. A chat node
   * decides whether its message has a durable position to address; the pending
   * steering bubble has none and receives no strip.
   */
  renderUserActions: RenderUserActions
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
  /**
   * Prose-referent scanner/opener from the optional {@link ProseReferents}
   * service, bound to this session's cwd/home. Undefined when the service is
   * absent — prose and inline code render exactly as before this seam
   * existed.
   */
  referents: MarkdownProseReferents | undefined
  /** Turn-process state when this Node belongs to a projected Turn. */
  turnProcess?: TurnProcessOwnerProps | undefined
}

/** Shared presentation state for one Turn-process answer generation. */
export interface TurnProcessOwnerProps {
  readonly spec: TurnProcessSpec
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}

/** Full props of one keyed Chat renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'>

/** Tool block rendered in the details panel. */
export interface DetailsToolOwnerProps {
  block: ToolCallBlock
  cwd?: string | undefined
}

/** Command-row owner share. */
export interface CommandRowOwnerProps {
  node: CommandNode
  compaction?: CompactionSummaryNode
}

/** Full props of a registered command row. */
export type CommandRowProps = PropsRuntime<'conversation.chat.commandview'>

/** Shared Chat store handle. */
export type ChatStore = ReturnType<typeof createChatStore>

/** In-memory reader position resilient to transcript reflow. */
export interface ChatScrollPosition {
  readonly anchorKey: string
  readonly anchorTop: number
  readonly scrollTop: number
}

/** Business callbacks injected into the Chat view. */
export interface ChatViewInjected {
  hooks: {
    /** Persisted completed-Turn transcript presentation. */
    transcriptView: SnapshotStore<TranscriptViewMode>
  }
  keyedHooks: {
    /** Resolve the stable source for one Chat Node key. */
    chatNode: (key: string) => ChatNodeSource
    /** Resolve the stable Turn-process source for one Chat Node key. */
    chatNodeProcess: (key: string) => ChatNodeProcessSource
  }
  openDetails: (target: SelectionTarget) => void
  openFile: (path: string) => Promise<void>
  loadOlder: () => void
  /** Jump loader: page history back through seq; resolves when the window covers it. */
  loadThrough: (seq: SessionSeq) => Promise<void>
  loadImage: MessageImageLoader
  chatScroll: {
    save: (position: ChatScrollPosition | null) => void
    read: () => ChatScrollPosition | null
  }
  forkAt: (seq: number) => void
  fileMentions: (owner: TurnTailOwnerProps) => MarkdownFileMentions | undefined
  /**
   * Prose-referent scanner/opener from the optional {@link ProseReferents}
   * service (resolved live, like {@link fileMentions}), bound to this
   * session's cwd/host home. Undefined when the service is absent.
   */
  referents: MarkdownProseReferents | undefined
}

/** Full Chat view props. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderSlots<'conversation.chat.node' | 'conversation.message.images' | 'conversation.chat.user-actions'>
  & PropsStore<ChatStore>
  & InjectFace<ChatViewInjected>
  & PropsLocale<'chat'>

/** Full props of the durable-message image renderer. */
export type MessageImagesProps = PropsRuntime<'conversation.message.images'> & PropsLocale<'conversation'>

/** Details-panel callbacks. */
export interface DetailsInjected {
  closeDetails: () => void
}

/** Full details-panel props. */
export type DetailsSlotProps =
  PropsRuntime<'details'>
  & PropsRenderSlots<'conversation.details.tool'>
  & PropsStore<ChatStore>
  & InjectFace<DetailsInjected>
  & PropsLocale<'chat'>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target. */
    useChat: UseChat
  }

  interface LocaleNamespaceMap {
    /** Chat target, transcript node, statistics, and details copy. */
    chat: import('../locale.ts').ChatKey
  }

  interface SlotMap {
    /**
     * Final Chat node renderer, keyed by `ChatNodeKind`. The component receives
     * the typed node, shared Chat actions, and Turn-data hook. Reusing a key
     * replaces that node renderer; a kind with no occupant renders no row.
     */
    'conversation.chat.node': {
      kind: 'keyed'
      scope: 'session'
      owner: ChatNodeOwnerProps
      keyProps: { [Kind in ChatNodeKind]: { node: ChatNode<Kind> } }
      hookContext: ConversationLocationDataStore<ConversationTurnDataMap> | undefined
      inject: ChatNodeTurnDataInjected
    }
    /**
     * Renderer for one consecutive group of durable message images. The owner
     * supplies image references, an authorized loader, and alignment. A
     * registration replaces the shipped gallery; without one, images are omitted.
     */
    'conversation.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Command row keyed by the command name. The component receives the folded
     * command lifecycle and linked compaction when present. Reusing a key
     * replaces that command renderer; an unoccupied key uses the generic card.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * Selector-routed extension before a completed Turn's action row. The
     * component receives the Turn, closing sequence, and file opener. The first
     * selector that accepts the owner renders; an all-declined chain is empty.
     */
    'conversation.chat.turnTail': { kind: 'chain'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Ordered actions for one finalized assistant message. Each entry receives
     * the durable message id; a fresh `id` adds an action and reusing one replaces
     * that entry. With no entries, the standard action row remains unchanged.
     */
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
    /**
     * Action strip attached to one user or admitted-steering message, rendered
     * inside that message's IconActions row. The chat view declares this seat
     * and hands every node a `renderUserActions` share: the `user` and
     * `steering` entries both render it, and a child key has exactly one
     * declaring entry. The render site passes the addressed message's log
     * position and rendered text, so contributors add per-message actions
     * without importing the chat implementation. Entries render by ascending
     * `order`.
     */
    'conversation.chat.user-actions': { kind: 'list'; scope: 'session'; owner: UserActionOwnerProps }
    /**
     * Whole details-panel body for the selected Tool call. The component receives
     * the running or settled block and optional workspace root. A registration
     * replaces the shipped Tool details renderer; absence uses the raw fallback.
     */
    'conversation.details.tool': { kind: 'single'; scope: 'session'; owner: DetailsToolOwnerProps }
  }
}
