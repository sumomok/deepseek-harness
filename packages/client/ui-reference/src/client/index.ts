/**
 * Unified Web `@` reference source. File and session discovery run through
 * the cancellable generated Remote namespaces in parallel with deterministic
 * ordering and labels; Workspace roots read the Client Workspace projection
 * without a Remote call.
 * Candidate requests retain an existing Client Session through completion
 * and wait for its initial history open to succeed before contacting the Host.
 *
 * Rows carry only what distinguishes them: a file names its parent directory
 * (nothing at the workspace root), a directory listing names none because its
 * breadcrumb already does, a Workspace root names its path so same-titled
 * roots stay distinct, and a session names its workspace only when that
 * workspace is not the current one. A session is dated from the Host session
 * list, so the `@` menu and the session list never disagree about its age.
 *
 * @module @deepseek-ai/dsh-client-ui-reference/client
 */
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions, ReferentRef } from '@deepseek-ai/dsh-api-session-controller/client'
import type { IWorkspaces, WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { FileReference, FolderReference, type FileReferenceInjected } from './FileReference.tsx'
import { fileReferenceRule, folderReferenceRule } from './user-text-rules.ts'
export type {} from './user-text-rules.ts'
import type {
  ClientSessionContext, InputTriggerCandidate, InputTriggerCrumb, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import {
  abbreviateHomePath, fileAddressFor, resolveWorkspacePath, workspaceTitleOf,
} from '@deepseek-ai/dsh-util-workspace-path'
import { en, es, fr, de, ja, pt, ru, NS, zh } from './locales.ts'

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** File and Session candidates waiting for initial history and their RPC results. */
    referenceCandidates: unknown
  }
}

/** Required services: the trigger registry, the Remote namespaces, the copy, the Workspace projection, and the reference-open seam. */
export const inject = [
  'inputTriggers', 'locale', 'sessions', 'workspaces', 'referent', 'remote', 'remote.fileReferences',
  'remote.sessionReferenceResolver', 'sidebarRight', 'slots', 'uiConversation',
]

/**
 * Register the combined `@file` / `@workspace` / `@session` source and independent file/folder text providers.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-reference: dictionaries')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.get('sessions') as ISessions
  const workspaces = ctx.get('workspaces') as IWorkspaces
  ctx.uiConversation.userText.register(fileReferenceRule)
  ctx.uiConversation.userText.register(folderReferenceRule)
  ctx.slots.inject('conversation.user.text.node', function* () {
    yield ctx.slots.register({
      name: 'conversation.user.text.node', key: 'file', priority: 100, locale: NS,
      inject: (sessionId: UserTextNodeProps<'file'>['sessionId']): FileReferenceInjected => ({
        // referent/open first: a listener may claim the click before the Sidebar opens the file.
        openFile: (path) => {
          const file = locateFile(sessions, sessionId, path)
          const ref: ReferentRef = {
            kind: 'file',
            target: file.target,
            raw: path,
            sessionId,
            source: 'user-text.file-reference',
            enteredAs: 'user-text',
          }
          return ctx.referent.open(ref, () => { ctx.sidebarRight.openResource(file.address) })
        },
      }),
    }, FileReference)
    yield ctx.slots.register({ name: 'conversation.user.text.node', key: 'folder', priority: 100 }, FolderReference)
  })
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'reference',
    showGroupTitle: false,
    async candidates(session: ClientSessionContext, { query, quoted, drilled, signal }) {
      if (sessions.binding(session.sessionId) === undefined) {
        throw new Error(`reference candidates require a retained session "${session.sessionId}"`)
      }
      const [fileItems, sessionItems] = await sessions.using(
        session.sessionId,
        { source: 'referenceCandidates', signal },
        async (reference) => {
          signal.throwIfAborted()
          const state = reference.binding.session.getSnapshot()
          if (state.openState !== 'open') {
            throw state.openError ?? new Error(`session "${session.sessionId}" is not open`)
          }
          const fileLookup = ctx.remote.fileReferences.list(session.sessionId, query, signal)
            .then(result => result.ok ? result.value : [])
          const sessionLookup = quoted === true
            ? Promise.resolve([] as SessionReferenceMentionCandidate[])
            : ctx.remote.sessionReferenceResolver.candidates(session.sessionId, query, signal)
              .then(result => result.ok ? result.value : [])
          return Promise.all([fileLookup, sessionLookup])
        },
      )
      if (signal.aborted) return []
      // The header already names the directory being listed; rows repeat it only
      // when there is no header to carry it.
      const withLocation = crumbsFor(query, quoted === true, drilled, t) === undefined
      const now = Date.now()
      const home = ctx.remote.$host.home
      // An open quoted path is file-path completion; Workspace roots answer the
      // same way Sessions do there: they stay out of the listing.
      const workspaceItems = quoted === true
        ? []
        : workspaceCandidates(workspaces.list.getSnapshot().items, query, home, t)
      const listed = sessions.list.getSnapshot().byId
      const sessionRows = sessionItems.map((candidate) => {
        const summary = listed[candidate.sessionId]
        const child = summary?.origin === 'subagent' && summary.parentId === session.sessionId
        return {
          child,
          row: sessionCandidate(
            candidate,
            candidate.displayTitle ?? candidate.label,
            summary?.updatedAt ?? candidate.createdAt,
            now,
            home,
            t(child ? 'section.subagents' : 'section.sessions'),
            t,
          ),
        }
      })
      return [
        ...fileItems.flatMap(candidate => fileCandidate(candidate, quoted === true, withLocation, t)),
        ...workspaceItems,
        ...sessionRows.filter(item => item.child).map(item => item.row),
        ...sessionRows.filter(item => !item.child).map(item => item.row),
      ]
    },
    header(_session: ClientSessionContext, req) {
      return crumbsFor(req.query, req.quoted === true, req.drilled, t)
    },
    onPick({ candidate, action }) {
      const value = parseCandidate(candidate.value)
      if (value?.kind === 'file') {
        // A directory row carries two verbs: the settling pick resolves the
        // folder itself as an atomic reference, while the drill action (Tab /
        // row chevron / a header crumb) keeps the literal descent text and
        // the open menu.
        if (value.fileKind === 'directory' && action === 'drill') {
          return { text: value.mention, continue: true }
        }
        return {
          insert: {
            source: 'reference',
            ref: value.mention,
            label: value.fileKind === 'directory' ? `${value.label}/` : value.label,
            appearance: value.fileKind === 'directory' ? 'folder' : 'file',
            clipboardText: value.mention,
          },
        }
      }
      if (value?.kind === 'session') {
        return {
          insert: {
            source: 'reference',
            ref: value.mention,
            label: value.label,
            appearance: 'session',
            clipboardText: value.mention,
          },
        }
      }
      return undefined
    },
    openReference(session, { ref, appearance }) {
      if (appearance !== 'file') return false
      const path = ref.startsWith('@"') ? ref.slice(2, -1) : ref.slice(1)
      ctx.sidebarRight.openResource(locateFile(sessions, session.sessionId, path).address)
      return true
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-reference: @ source')
}

/** Bound `reference` dictionary; the locale service appends the shared common vocabulary. */
type Translate = TranslateNS<typeof NS>

/**
 * The directory a Session's relative paths resolve against at this moment: its
 * current working directory when the Client holds that projection, which is
 * also the directory `@` candidates are listed relative to, otherwise its
 * header directory.
 * @param sessions - the Client Session registry.
 * @param sessionId - the Session the path belongs to.
 * @returns an absolute directory, or undefined when neither is known.
 */
function currentDirectoryOf(sessions: ISessions, sessionId: ClientSessionContext['sessionId']): string | undefined {
  const current = sessions.binding(sessionId)?.session.projections.faceOf('workingDirectory').getSnapshot()
  return typeof current === 'string' ? current : sessions.list.getSnapshot().byId[sessionId]?.cwd
}

/**
 * Locate a file reference when it is opened: the path resolves against the
 * Session's current directory at that moment, and the address keeps the
 * header directory as its root, so a file inside the header workspace gets a
 * Session-relative address and a file elsewhere keeps its absolute path.
 * @param sessions - the Client Session registry.
 * @param sessionId - the Session the reference belongs to.
 * @param path - absolute or relative path as written in the reference.
 * @returns the resolved path and its right-Sidebar address.
 */
function locateFile(
  sessions: ISessions,
  sessionId: ClientSessionContext['sessionId'],
  path: string,
): { readonly target: string; readonly address: string } {
  const target = resolveWorkspacePath(currentDirectoryOf(sessions, sessionId), path)
  return { target, address: fileAddressFor(sessionId, sessions.list.getSnapshot().byId[sessionId]?.cwd, target) }
}

type ReferenceCandidateValue =
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'session'; label: string; mention: string }

/**
 * The breadcrumb of a drilled directory listing, from the workspace root down
 * to the directory being listed.
 *
 * Only a drill produces one: a path the user typed carries its own context in
 * the draft, while a drill replaced the text they were reading with a deeper
 * one and owes them the way back.
 * @param query - the live query, path text following `@` or `@"`.
 * @param quoted - whether the active token is an open quoted path.
 * @param drilled - whether a drill pick, rather than typing, produced the query.
 * @param t - the reference dictionary.
 * @returns the crumbs, or undefined when this listing needs no header.
 */
function crumbsFor(
  query: string,
  quoted: boolean,
  drilled: boolean,
  t: Translate,
): readonly InputTriggerCrumb[] | undefined {
  if (!drilled) return undefined
  const slash = query.lastIndexOf('/')
  if (slash < 0) return undefined
  const segments = query.slice(0, slash).split('/').filter(segment => segment !== '')
  const crumbs: InputTriggerCrumb[] = [{
    label: t('crumb.root'),
    value: directoryValue(t('crumb.root'), quoted ? '@"' : '@'),
  }]
  for (const [index, segment] of segments.entries()) {
    const path = segments.slice(0, index + 1).join('/')
    const mention = formatFileMention({ path, kind: 'directory' }, quoted)
    // A trail whose steps cannot all be written back as mention text would
    // send the user somewhere they did not click; show no header instead.
    if (mention === undefined) return undefined
    crumbs.push({
      label: segment,
      value: directoryValue(segment, mention),
      ...(index === segments.length - 1 ? { current: true } : {}),
    })
  }
  return crumbs
}

/** Project one directory destination as the drill payload `onPick` already understands. */
function directoryValue(label: string, mention: string): string {
  const value: ReferenceCandidateValue = { kind: 'file', fileKind: 'directory', label, mention }
  return JSON.stringify(value)
}

/**
 * Workspace-root rows for one query, in Host registry order.
 *
 * A row matches its displayed title or its root path, and roots dedupe on that
 * canonical path so a duplicate registration cannot repeat a mention.
 * @param items - Host Workspace projections in registry order.
 * @param query - text following `@`, matched case-insensitively.
 * @param home - Host account home for the displayed path.
 * @param t - the reference dictionary.
 * @returns one folder-shaped row per distinct mentionable root.
 */
function workspaceCandidates(
  items: readonly WorkspaceView[],
  query: string,
  home: string | undefined,
  t: Translate,
): InputTriggerCandidate[] {
  const needle = query.replaceAll('\\', '/').toLowerCase()
  const defaultTitle = t('workspace.defaultName')
  const section = t('section.workspaces')
  const seen = new Set<string>()
  const rows: InputTriggerCandidate[] = []
  for (const item of items) {
    const path = workspaceRootPath(item.path)
    // An empty projection has no directory to mention.
    if (path === '' || seen.has(path)) continue
    seen.add(path)
    const title = workspaceDisplayTitle(item.title, defaultTitle) || workspaceTitleOf(item.path)
    if (needle !== '' && !title.toLowerCase().includes(needle) && !path.toLowerCase().includes(needle)) continue
    const mention = workspaceMention(path)
    if (mention === undefined) continue
    const value: ReferenceCandidateValue = { kind: 'file', fileKind: 'directory', label: title, mention }
    rows.push({
      name: title,
      description: abbreviateHomePath(item.path, home),
      icon: 'folder',
      section,
      value: JSON.stringify(value),
    })
  }
  return rows
}

/**
 * Canonical root spelling for a mention: forward slashes, no trailing separator.
 * @param path - Host Workspace path in either separator spelling.
 * @returns the normalized root path, or an empty string for an empty projection.
 */
function workspaceRootPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/\/+$/u, '')
  return normalized === '' && path !== '' ? '/' : normalized
}

/**
 * Complete directory mention for a Workspace root. The shared formatter keeps a
 * quoted directory's quote open so completion can descend inside it; a
 * Workspace row settles atomically, so its mention closes that quote.
 * @param path - normalized absolute root path.
 * @returns the mention text, or undefined when the grammar cannot carry it.
 */
function workspaceMention(path: string): string | undefined {
  // A filesystem root is the one empty formatter path the grammar still names.
  const mention = formatFileMention({ path: path === '/' ? '' : path, kind: 'directory' }, false)
  if (mention === undefined) return undefined
  return mention.startsWith('@"') ? `${mention}"` : mention
}

function fileCandidate(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
  withLocation: boolean,
  t: Translate,
) {
  const mention = formatFileMention(candidate, preserveQuote)
  if (mention === undefined) return []
  const slash = candidate.path.lastIndexOf('/')
  const name = candidate.path.slice(slash + 1)
  const parent = slash < 0 ? '' : candidate.path.slice(0, slash)
  const directory = candidate.kind === 'directory'
  const value: ReferenceCandidateValue = {
    kind: 'file',
    fileKind: candidate.kind,
    label: name,
    mention,
  }
  return [{
    name: `${name}${directory ? '/' : ''}`,
    // The location is the parent alone: repeating the name the row already
    // shows says nothing, and a workspace-root entry has no parent to name.
    ...(withLocation && parent !== '' ? { description: parent } : {}),
    icon: directory ? 'folder' as const : 'file' as const,
    section: t('section.files'),
    value: JSON.stringify(value),
    ...(directory ? { drill: true } : {}),
  }]
}

function sessionCandidate(
  candidate: SessionReferenceMentionCandidate,
  label: string,
  updatedAt: number,
  now: number,
  home: string | undefined,
  section: string,
  t: Translate,
) {
  const { unit, n } = relativeTime(updatedAt, now)
  const age = unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
  // Candidates are ranked by workspace affinity, so the location only tells
  // the user something when it is not the workspace they are already in.
  const location = candidate.sameWorkspace
    ? undefined
    : candidate.cwd === undefined ? t('candidate.noCwd') : abbreviateHomePath(candidate.cwd, home)
  const value: ReferenceCandidateValue = {
    kind: 'session',
    label,
    mention: candidate.mention,
  }
  return {
    name: label,
    description: location === undefined ? age : `${location} · ${age}`,
    icon: 'session' as const,
    section,
    value: JSON.stringify(value),
  }
}

function parseCandidate(value: string | undefined): ReferenceCandidateValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(value) as ReferenceCandidateValue
}
