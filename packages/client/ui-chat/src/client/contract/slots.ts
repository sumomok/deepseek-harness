/** Chat-owned Slot declarations and composed component props. */
import type { ReactNode, RefObject } from 'react'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ReferentKind } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { InboxState } from '@deepseek-ai/dsh-agent/types'
import type {
  CommandNode, CompactionSummaryNode, ConversationLocationDataStore, ConversationTurnDataMap,
  TextInteractionGesture, TextInteractionSurface,
  ConversationGroupData, GroupSnapshot,
  MessageImageLoader, MessageImageSource, MessageImagesOwnerProps, RenderEntry, TurnLocation, UserTextFacts, UserTextInput,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  HostObservable, InjectFace, KeyedSnapshotSelectorHook, PropsLocale, PropsRenderSlots, PropsRuntime,
  PropsRenderFactories, PropsStore, SlotHookFactory, SnapshotSelectorHook,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { ConnectionStateSource } from '@deepseek-ai/dsh-client-connection/client'
import type {
  MarkdownFileMentions, MarkdownLabels, MarkdownProseReferents,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the Session-scope access Hook (`useAccess`) the Chat entries read.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { createChatStore } from '../stores.ts'
import type { ChatPresentationPolicy } from '../presentation-policy.ts'
import type { FlowMotionRows } from '../chat/flow-motion.ts'
import type { ToolCallId } from './store.ts'
import type { ChatConversationViewNode, ChatNode, ChatNodeKind } from './chat-nodes.ts'
import type {
  ChatNodeProcessSource, ChatNodeSource, ChatSnapshot, ChatTurnProcessPresentation,
} from './snapshot.ts'
import type { TurnProcessSpec } from './turn-process.ts'
import type { PerformanceUsageMode } from '../../chat-settings.ts'

/** Selector hook over the current Conversation binding's Chat target. */
export type UseChat = SnapshotSelectorHook<ChatSnapshot>

/** Per-key selector hook over one Chat Node. */
export type UseChatNode = KeyedSnapshotSelectorHook<ChatConversationViewNode | undefined>

/** Per-key selector hook over one Chat Node's Turn-process presentation. */
export type UseChatNodeProcess = KeyedSnapshotSelectorHook<ChatTurnProcessPresentation | undefined>

/**
 * Selector hook over the live presentation policy. Callers select one field or
 * a derived conclusion, never the whole policy, so a mode change re-renders
 * only components whose selected value changed.
 */
export type UsePresentation = SnapshotSelectorHook<ChatPresentationPolicy>

/** Where in a file an open should land. */
export interface OpenFileOptions {
  /** 1-based line to reveal; absent = the file's beginning. */
  readonly line?: number
}

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

/**
 * Owner share of the session token-usage pill and its dialog: the same figures
 * the shipped pill prints, so an occupant of either usage seat reads the
 * session's billed totals without importing the chat implementation.
 */
export interface StatsUsageOwnerProps {
  /** Every prompt-side billing bucket plus output over the whole durable log, exact. */
  totalTokens: number
  /**
   * Cache-hit share of billed input as the pill prints it (the bare number,
   * e.g. "93"), or null when nothing was billed yet.
   */
  cacheHitPercent: string | null
}

/** Slot-backed renderer for the actions one user-side message offers. */
export type RenderUserActions = (owner: UserActionOwnerProps) => ReactNode

/** Stable quota failure codes retained in the Session log; both raise the frame-wide notice. */
export type QuotaNoticeCode = 'QUOTA' | 'ACCOUNT_QUOTA'

/** The notice on display; `seq` keys remounts so an unretained later notice restarts its transient display. */
export interface QuotaNoticeState {
  /** Stable failure code retained in the Session log. */
  code: QuotaNoticeCode
  /** Per-publication sequence; the host keys its surface by it. */
  seq: number
}

/** Original model-provided reasoning offered to the expanded Body Slot. */
export interface ReasoningBodyOwnerProps {
  /** Complete or streaming reasoning text. */
  readonly text: string
  /** Whether the reasoning tail is still streaming. */
  readonly running: boolean
}

/** Session-independent original or derived display input to the Content Factory. */
export interface ReasoningContentInput extends ReasoningBodyOwnerProps {
  /** Localized Markdown controls, used unchanged when supplied; omission uses Chat's defaults. */
  readonly labels?: MarkdownLabels
}

/** Owner currency of one quota notice offered to the frame-wide chain. */
export interface QuotaNoticeOwnerProps {
  /** Stable failure code retained in the Session log. */
  code: QuotaNoticeCode
  /** Provider-neutral notice copy in the active locale. */
  message: string
  /** Take the notice down. */
  dismiss: () => void
  /**
   * Prevent later quota failures from replacing this notice. Dismissal clears
   * all holds; releasing the last hold resumes future notices without replay.
   * Callers must release on unmount.
   * @returns idempotent release that cannot clear another hold.
   */
  keepOpen: () => () => void
}

/** Quota notice host share: the notice on display and its dismissal. */
export interface QuotaNoticeInjected {
  hooks: {
    /** The notice on display, or none. */
    notice: HostObservable<QuotaNoticeState | null>
  }
  /** Take the notice down. */
  dismissNotice: () => void
  /**
   * Acquire a hold with the lifecycle defined by QuotaNoticeOwnerProps.keepOpen.
   * @returns idempotent release, or a no-op when no notice is live.
   */
  keepNoticeOpen: () => () => void
}

/** Full props of the Chat-owned frame-wide quota notice host. */
export type QuotaNoticeHostProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'chat'>
  & PropsRenderSlots<'shell.quota-notice'>
  & InjectFace<QuotaNoticeInjected>

/** Optional prose file-mention provider consumed by Chat. */
export interface ChatFileMentions {
  /**
   * Resolve prose links for one closing Turn.
   * @param owner - closing-Turn identity and file opener.
   * @param sessionId - viewed Session, including when history is inherited from a fork.
   * @returns link resolver when available.
   */
  forClosing(owner: TurnTailOwnerProps, sessionId: SessionId): MarkdownFileMentions | undefined
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
   * @param context - `cwd`/`home` resolve a relative candidate. `cwd` is the
   * session's current working directory at this call, or its header
   * directory when no working directory is recorded (undefined wherever the
   * session/workspace has neither — the provider decides whether that
   * suppresses a span or not); `inlineCode` is true for an inline-code
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

/**
 * Subscribe to enclosing-Turn resets and own one initially collapsed disclosure.
 * Each invocation has independent open state; display-mode changes do not reset it.
 * @returns the current open state, explicit setter, and toggle action.
 */
export type UseDisclosure = () => {
  readonly expanded: boolean
  /** @param open - whether this disclosure is expanded. */
  readonly setExpanded: (open: boolean) => void
  readonly toggle: () => void
}

/**
 * Searchable process hiding bound to the current node render's viewport.
 * @param hidden - desired hidden state.
 * @param reveal - browser-find and focus-protection callback.
 * @returns the stable process-container ref.
 */
export type UseGroupAction = (hidden: boolean, reveal: () => void) => RefObject<HTMLDivElement>

/**
 * Plain header visibility bound to the flow's viewport, including growth on reveal.
 * @param ref - stable header element.
 * @param hidden - desired hidden state.
 */
export type UseGroupHeaderAction = (ref: RefObject<HTMLElement | null>, hidden: boolean) => void

/** Viewport capability supplied once for each rendered Chat flow. */
export interface ChatFlowHookContext {
  readonly motion: FlowMotionRows
}

/** Flow-wide behavior hooks bound to one viewport, independently of Session identity. */
export interface ChatFlowInjected {
  hooks: {
    groupAction: SlotHookFactory<'conversation.chat.flow', UseGroupAction>
    groupHeaderAction: SlotHookFactory<'conversation.chat.flow', UseGroupHeaderAction>
  }
}

/** Stable sources and capabilities bound to one rendered Chat Node. */
export interface ChatNodeHookContext {
  readonly turnData: ConversationLocationDataStore<ConversationTurnDataMap> | undefined
  readonly disclosureReset: ObservableSnapshot<number>
  readonly useGroupAction: UseGroupAction
}

/** Slot-level Hook factories for keyed Chat renderers. */
export interface ChatNodeInjected {
  hooks: {
    turnData: SlotHookFactory<'conversation.chat.node', UseChatNodeTurnData>
    disclosure: SlotHookFactory<'conversation.chat.node', UseDisclosure>
    groupAction: SlotHookFactory<'conversation.chat.node', UseGroupAction>
  }
}

/**
 * Owner currency of the message-source decoration above one user message bubble.
 *
 * Entry selectors receive the durable message `source` and row kind. A
 * non-null selection elects the component and reaches it as `matched`.
 * Entries own their markup and copy; Chat does not interpret the source.
 */
export interface UserBeforeOwnerProps {
  /** Durable message source; Chat does not interpret it. */
  readonly source: unknown
  /** Chat row kind that owns the decoration site. */
  readonly kind: 'user' | 'steering'
}

/** Stable owner currency delivered to a keyed Chat renderer. */
export interface ChatNodeOwnerProps {
  /** Renderer-owned Node portion selected by the grouping Definition. */
  groupPart?: string
  cwd?: string | undefined
  openFile: (path: string, options?: OpenFileOptions) => void
  inspectCall: ((callId: ToolCallId) => void) | undefined
  forkAt: (seq: number) => void
  /** Session-authorized image loader supplied by the Chat view. */
  loadImage: MessageImageLoader
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

/** One attachment in the original user-message display order. */
export type UserContentAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: FileAttachmentRef }

/** Prepared user contents without row identity, admission state, time, or actions. */
export interface UserContentData {
  readonly text: string
  readonly attachments: readonly UserContentAttachment[]
  /** Blocks not represented by text or attachment presentation. */
  readonly extraBlocks: readonly unknown[]
  /** Labels displayed in the caller-provided reference summary. */
  readonly referenceLabels?: readonly string[]
  /**
   * Labels of the prompt references recorded on the message source, in
   * reference order; the attachment row shows each as a chip. Absent when the
   * message carries none.
   */
  readonly promptReferenceLabels?: readonly string[]
}

/** Public content rendering input; reference renderers own their injected actions. */
export interface UserContentInput extends Pick<ChatNodeOwnerProps, 'loadImage'>,
  Pick<UserTextInput, 'interactive' | 'ellipsis'> {
  readonly content: UserContentData
  /** Transform inputs passed unchanged to UserText, separate from summary and rendering props. */
  readonly facts: Readonly<Partial<UserTextFacts>>
}

/** Shared presentation state for one Turn-process answer generation. */
export interface TurnProcessOwnerProps {
  /** Process content eligible to share one Turn-level disclosure. */
  readonly hasContent: boolean
  readonly spec: TurnProcessSpec
  readonly foldable: boolean
  readonly open: boolean
  setOpen(open: boolean): void
}

/** Shared presentation policy source for renderers that depend on the work-details mode. */
export interface PresentationInjected {
  hooks: {
    /** Live presentation policy derived from the accepted work-details mode. */
    presentation: ObservableSnapshot<ChatPresentationPolicy>
  }
}

/** Full props of one keyed Chat renderer. */
export type ChatNodeViewProps<Kind extends ChatNodeKind = ChatNodeKind> =
  PropsRuntime<'conversation.chat.node', Kind> & PropsLocale<'chat'> & PropsRenderFactories

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

/** Shared settings source for the performance row, composer, and turn tail. */
export interface PerformanceUsageInjected {
  hooks: {
    /** Accepted performance and usage detail preference. */
    performanceUsage: ObservableSnapshot<PerformanceUsageMode>
  }
}

/** Business callbacks injected into the Chat view. */
export interface ChatViewInjected {
  /** File preparation and failure callbacks owned by the file-drag plugin. */
  readonly fileDrag: import('@deepseek-ai/dsh-client-ui-primitives').FileDragActions
  /** Dispatch one gesture to the Conversation plugin registry. */
  dispatchInteraction: (gesture: TextInteractionGesture) => string | null
  hooks: {
    /** Live plugin IDs; removed plugins dismiss their active surface. */
    interactionIds: ObservableSnapshot<readonly string[]>
    /** Live presentation policy derived from the accepted work-details mode. */
    presentation: ObservableSnapshot<ChatPresentationPolicy>
  }
  keyedHooks: {
    /** Resolve the stable source for one Chat Node key. */
    chatNode: (key: string) => ChatNodeSource
    /** Observe assembler-owned bottom membership for one Node. */
    chatNodeBottom: (key: string) => ObservableSnapshot<boolean>
    /** Resolve the stable Turn-process source for one Chat Node key. */
    chatNodeProcess: (key: string) => ChatNodeProcessSource
    /** Resolve one optional group without subscribing the root View to its data. */
    chatGroup: (key: string) => ObservableSnapshot<GroupSnapshot<ConversationGroupData<'chat'>> | undefined> | undefined
  }
  /** Open one HTTP(S) message link at the selected destination, using an external tab if Sidebar Browser is unavailable. */
  openExternalLink: (url: string) => void
  openFile: (path: string, options?: OpenFileOptions) => Promise<void>
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

/** Session-owned node sources shared with the view, plus the flow's connection state. */
export type ChatFlowDataInjected = Pick<ChatViewInjected, 'keyedHooks'> & {
  hooks: Pick<ChatViewInjected['hooks'], 'presentation'> & {
    /** Client connection lifecycle; the running clock pauses while it is not connected. */
    connectionState: ConnectionStateSource
  }
}

/** Ordered rows and reconciled local echoes rendered inside one Chat viewport. */
export interface ChatFlowOwnerProps extends Pick<ChatNodeOwnerProps,
  'cwd' | 'openFile' | 'inspectCall' | 'forkAt' | 'loadImage' | 'fileMentions' | 'referents'> {
  readonly entries: readonly RenderEntry[]
  readonly pendingInputs: readonly (PendingSubmission | InboxState['next-step'][number])[]
  readonly lastInputTurn: number | undefined
  readonly deferCollapse: boolean
}

/** Full props of the Chat-owned flow renderer. */
export type ChatFlowSlotProps =
  PropsRuntime<'conversation.chat.flow'>
  & PropsRenderSlots<'conversation.chat.node' | 'conversation.chat.user-actions'>
  & PropsRenderFactories
  & PropsStore<ChatStore>
  & InjectFace<ChatFlowDataInjected>
  & PropsLocale<'chat'>

/** Full Chat view props. */
export type ChatViewSlotProps =
  PropsRuntime<'conversation.view'>
  & PropsRenderSlots<'conversation.chat.flow' | 'conversation.chat.text-interaction'>
  & PropsStore<ChatStore>
  & InjectFace<ChatViewInjected>
  & PropsLocale<'chat'>

/** Full props shared by the user and output image entries. */
export type MessageImagesProps =
  PropsRuntime<'conversation.chat.user.images' | 'conversation.chat.message.images'> & PropsRenderFactories

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target. */
    useChat: UseChat
  }

  interface LocaleNamespaceMap {
    /** Chat target, transcript node, statistics, and details copy. */
    chat: import('../locale.ts').ChatKey
  }

  interface SlotFactoryMap {
    /** Prepared user text, attachments, and references inside a caller-owned message row. */
    'conversation.chat.user.content': {
      scope: 'session'
      props: UserContentInput
      locale: 'chat'
      children: { 'conversation.chat.user.images': { kind: 'single'; scope: 'session' } }
    }
    /** Session-independent reasoning Markdown with Chat labels and compact typography. */
    'conversation.chat.reasoning.content': {
      scope: 'root'
      props: ReasoningContentInput
      locale: 'chat'
    }
  }

  interface SlotMap {
    /** Area-local text gestures and surfaces; each consumer registers its own synchronous admission. */
    'conversation.chat.text-interaction': { kind: 'keyed'; scope: 'session'; owner: TextInteractionSurface }

    /** Ordered Chat rows and local echoes with viewport-bound visibility hooks. */
    'conversation.chat.flow': {
      kind: 'single'
      scope: 'session'
      owner: ChatFlowOwnerProps
      hookContext: ChatFlowHookContext
      inject: ChatFlowInjected
    }
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
      hookContext: ChatNodeHookContext
      inject: ChatNodeInjected
    }
    /**
     * Message-source decoration owned and rendered by the user Node entry.
     * Selectors elect one component from the durable source and row kind.
     * No match renders no visible content; steering and pending rows do not
     * render this slot.
     */
    'conversation.chat.user.before': {
      kind: 'chain'
      scope: 'session'
      owner: UserBeforeOwnerProps
    }
    /**
     * Renderer for one consecutive group of durable message images. The owner
     * supplies image references, an authorized loader, and alignment. A
     * registration replaces the shipped gallery; without one, images are omitted.
     */
    'conversation.chat.message.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /** User-message images, including pending and local-echo previews, independently replaceable from output images. */
    'conversation.chat.user.images': { kind: 'single'; scope: 'session'; owner: MessageImagesOwnerProps }
    /**
     * Command row keyed by the command name. The component receives the folded
     * command lifecycle and linked compaction when present. Reusing a key
     * replaces that command renderer; an unoccupied key uses the generic card.
     */
    'conversation.chat.commandview': { kind: 'keyed'; scope: 'session'; owner: CommandRowOwnerProps }
    /**
     * Expanded reasoning body with the unchanged model text. The official entry
     * has priority 100 and calls the reasoning Content Factory; smaller priority
     * values replace it. Contributions must preserve access to the original text.
     */
    'conversation.chat.reasoning.body': { kind: 'single'; scope: 'session'; owner: ReasoningBodyOwnerProps }
    /**
     * Ordered feature contributions before a completed Turn's action row. Each
     * entry receives the Turn, closing sequence, and file opener. A fresh `id`
     * adds an entry; entries without content return null.
     */
    'conversation.chat.turnTail': { kind: 'list'; scope: 'session'; owner: TurnTailOwnerProps }
    /**
     * Ordered actions for one finalized assistant message. Each entry receives
     * the durable message id; a fresh `id` adds an action and reusing one replaces
     * that entry. With no entries, the standard action row remains unchanged.
     */
    'conversation.chat.assistant-actions': { kind: 'list'; scope: 'session'; owner: AssistantActionOwnerProps }
    /**
     * Action strip attached to one user or admitted-steering message, rendered
     * inside that message's IconActions row. The Chat flow declares this seat
     * and hands every node a `renderUserActions` share: the `user` and
     * `steering` entries both render it, and a child key has exactly one
     * declaring entry. The render site passes the addressed message's log
     * position and rendered text, so contributors add per-message actions
     * without importing the chat implementation. Entries render by ascending
     * `order`.
     */
    'conversation.chat.user-actions': { kind: 'list'; scope: 'session'; owner: UserActionOwnerProps }
    /**
     * Leading segment of the session token-usage pill's label, in place of the
     * shipped token total. The cache-hit segment the pill appends after it is
     * unaffected, and an unoccupied seat prints the token total. The button
     * carries no `aria-label`: its accessible name is whatever this seat and
     * the cache-hit segment render. The token-total fallback covers an empty
     * seat only — an occupant that throws is replaced by the error face, not
     * by the fallback, so an occupant carries its own failure reading.
     */
    'conversation.chat.stats.usageLabel': { kind: 'single'; scope: 'session'; owner: StatsUsageOwnerProps }
    /**
     * Extra rows at the end of the token-usage dialog's bucket list, after the
     * output row. Each entry renders one or more `dt`/`dd` pairs and inherits
     * the list's skin; they land one level below the `dl`, inside the render
     * site's `display: contents` slot anchor, which keeps them grid items of
     * the list and out of the accessibility tree. Entries render by ascending
     * `order`; with no entries the dialog is exactly the shipped one.
     */
    'conversation.chat.stats.usageRows': { kind: 'list'; scope: 'session'; owner: StatsUsageOwnerProps }
    /**
     * Frame-wide quota notice chain. The Chat-owned host in `shell.overlay`
     * offers the one live notice; the first entry whose selector claims its
     * code takes over the surface, and the all-decline case renders the host's
     * generic warning Toast. The host lives outside the Chat panel, so a notice
     * survives switching or closing the panel that reported it.
     */
    'shell.quota-notice': { kind: 'chain'; scope: 'root'; owner: QuotaNoticeOwnerProps }
  }
}
