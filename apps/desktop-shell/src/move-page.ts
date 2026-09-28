/**
 * The data move's own pages as plain data and as `data:` documents: the
 * progress window, the page for a move stopped partway, and the pages that
 * keep the application from starting. Like the boot page they are
 * self-contained documents with no preload and no IPC; a button is a link to
 * `dsh-move://<action>`, which the window intercepts in `will-navigate` and
 * never loads (plan D7).
 * @module @deepseek-ai/dsh-desktop-shell/move-page
 */

import { dirname } from 'node:path'
import type { MoveText } from './move-text.ts'
import { formatBytes } from './move-text.ts'
import { CANCELLABLE_PHASES, type BlockedChoice, type MoveJournal } from './move/journal.ts'
import type { LockLoss, LockState } from './move/lock.ts'
import type { MoveOutcome, MoveProgress } from './move/run.ts'
import { PALETTES, type Appearance } from './theme.ts'

/** The scheme the pages' buttons link to. */
export const MOVE_LINK_SCHEME = 'dsh-move:'

/** What a button asks for. */
export type MoveLink =
  | { kind: 'cancel' }
  | { kind: 'choose'; choice: BlockedChoice }
  | { kind: 'reveal'; index: number }
  | { kind: 'quit' }
  /** Discard another installation's unfinished move: asks for confirmation first. */
  | { kind: 'discard-lock' }
  /** Confirm what the page asks. */
  | { kind: 'confirm' }
  /** Go back to the page before. */
  | { kind: 'back' }
  /** Abandon a move that lost its lock. */
  | { kind: 'abandon' }
  /** Try a move again. */
  | { kind: 'retry' }
  /** Take back a move that lost its lock after hiding began. */
  | { kind: 'roll-back' }

/**
 * The link a button carries.
 * @param link - what it asks for.
 * @returns the `dsh-move://` URL.
 */
export function moveLinkUrl(link: MoveLink): string {
  switch (link.kind) {
    case 'cancel':
    case 'quit':
    case 'discard-lock':
    case 'confirm':
    case 'back':
    case 'abandon':
    case 'retry':
    case 'roll-back':
      return `${MOVE_LINK_SCHEME}//${link.kind}`
    case 'choose':
      return `${MOVE_LINK_SCHEME}//choose?c=${link.choice}`
    case 'reveal':
      return `${MOVE_LINK_SCHEME}//reveal?i=${String(link.index)}`
    default:
      return link satisfies never
  }
}

/**
 * Read a navigation the page started.
 * @param url - the URL the page navigated to.
 * @returns what the button asks for; `undefined` for anything that is not one of the page's links.
 */
export function parseMoveLink(url: string): MoveLink | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    // TypeError: not a URL at all, so not one of the page's links.
    return undefined
  }
  if (parsed.protocol !== MOVE_LINK_SCHEME) return undefined
  switch (parsed.hostname) {
    case 'cancel':
      return { kind: 'cancel' }
    case 'quit':
      return { kind: 'quit' }
    case 'discard-lock':
      return { kind: 'discard-lock' }
    case 'confirm':
      return { kind: 'confirm' }
    case 'back':
      return { kind: 'back' }
    case 'abandon':
      return { kind: 'abandon' }
    case 'retry':
      return { kind: 'retry' }
    case 'roll-back':
      return { kind: 'roll-back' }
    case 'choose': {
      const choice = parsed.searchParams.get('c')
      return choice === 'keep-target' || choice === 'rollback' ? { kind: 'choose', choice } : undefined
    }
    case 'reveal': {
      const index = Number(parsed.searchParams.get('i'))
      return Number.isSafeInteger(index) && index >= 0 ? { kind: 'reveal', index } : undefined
    }
    default:
      return undefined
  }
}

/** A page with a title, paragraphs, and buttons. */
export interface MovePage {
  title: string
  /** A line above the paragraphs, for a page redrawn after a refused choice. */
  notice?: string
  paragraphs: string[]
  buttons: Array<{ label: string; link: MoveLink }>
  /** The folders the reveal buttons show, by index. */
  reveal: string[]
}

/**
 * The page for a move stopped partway, from the journal and the executor's
 * `blocked` outcome. Only the choices the move offers now get a button.
 * @param journal - the journal.
 * @param blocked - the outcome.
 * @param text - the sentence set.
 * @param input - the platform, the name an unused copy would get, and whether a choice was just refused.
 * @returns the page.
 */
export function blockedPage(
  journal: Pick<MoveJournal, 'source' | 'target' | 'hidden' | 'sameVolume' | 'targetExposed'>,
  blocked: Extract<MoveOutcome, { kind: 'blocked' }>,
  text: MoveText,
  input: { platform: NodeJS.Platform; unusedName: string; refreshed: boolean },
): MovePage {
  const { source, target, sameVolume } = journal
  const targetParent = dirname(target)
  const offers = (choice: BlockedChoice): boolean => blocked.choices.includes(choice)
  const paragraphs: string[] = []
  const reveal: string[] = []
  let goBackLabel = text.goBack
  switch (blocked.reason) {
    case 'source-occupied':
      if (sameVolume) paragraphs.push(text.sourceOccupiedSame(source, target))
      else {
        paragraphs.push(text.sourceOccupiedAcross(source) + (blocked.dataAt.includes(target) ? text.alsoAtTarget(target) : ''))
        reveal.push(journal.hidden)
      }
      if (offers('keep-target')) paragraphs.push(text.sourceOccupiedWays(target, source))
      break
    case 'choice-needed':
      if (sameVolume) paragraphs.push(text.choiceSame(target, source))
      else if (journal.targetExposed) paragraphs.push(text.choiceAcrossUsed(target, source, input.unusedName, targetParent))
      else paragraphs.push(text.choiceAcrossUnused(target, source))
      break
    case 'target-changed':
      paragraphs.push(sameVolume ? text.changedSame(target, source) : text.changedAcross(target, source, input.unusedName, targetParent))
      break
    case 'target-missing':
      paragraphs.push(text.targetMissing(target, source, input.unusedName))
      goBackLabel = text.goBackWithout
      break
    case 'target-occupied':
      paragraphs.push(text.targetOccupied(target))
      reveal.push(journal.hidden)
      break
    case 'original-missing':
      paragraphs.push(offers('keep-target') ? text.originalMissing(source, target, input.unusedName) : text.bothMissing(source, target))
      break
    default:
      blocked.reason satisfies never
  }
  const buttons: MovePage['buttons'] = []
  if (offers('keep-target')) buttons.push({ label: text.keepTarget, link: { kind: 'choose', choice: 'keep-target' } })
  if (offers('rollback')) buttons.push({ label: goBackLabel, link: { kind: 'choose', choice: 'rollback' } })
  reveal.forEach((_path, index) => { buttons.push({ label: text.reveal(input.platform), link: { kind: 'reveal', index } }) })
  buttons.push({ label: text.quit, link: { kind: 'quit' } })
  return { title: text.blockedTitle, ...input.refreshed ? { notice: text.refreshed } : {}, paragraphs, buttons, reveal }
}

/**
 * A page with one sentence, a way to show a file, and quit.
 * @param title - the title.
 * @param sentence - the sentence.
 * @param text - the sentence set.
 * @param input - the platform and the file to show, if any.
 * @returns the page.
 */
export function stopPage(title: string, sentence: string, text: MoveText, input: { platform: NodeJS.Platform; reveal?: string }): MovePage {
  const reveal = input.reveal === undefined ? [] : [input.reveal]
  return {
    title,
    paragraphs: [sentence],
    buttons: [
      ...reveal.map((_path, index) => ({ label: text.reveal(input.platform), link: { kind: 'reveal' as const, index } })),
      { label: text.quit, link: { kind: 'quit' } },
    ],
    reveal,
  }
}

/** A lock that keeps the application off a data directory. */
export type ForeignLock = Exclude<LockState, { kind: 'none' } | { kind: 'ours' }>

/**
 * The page for a data directory another installation holds the move lock of,
 * or whose lock cannot be read. An unfinished move's page shows the lock
 * file and offers to discard that move, which {@link discardLockPage} confirms.
 * @param text - the sentence set.
 * @param lock - what holds the lock.
 * @param home - the data directory.
 * @param platform - whose file browser the reveal button names.
 * @param notice - a line above the page, for a page shown again after the lock changed.
 * @returns the page.
 */
export function lockPage(text: MoveText, lock: ForeignLock, home: string, platform: NodeJS.Platform, notice?: string): MovePage {
  const page = lockPageBody(text, lock, home, platform)
  return notice === undefined ? page : { ...page, notice }
}

/**
 * {@link lockPage} without its notice.
 * @param text - the sentence set.
 * @param lock - what holds the lock.
 * @param home - the data directory.
 * @param platform - whose file browser the reveal button names.
 * @returns the page.
 */
function lockPageBody(text: MoveText, lock: ForeignLock, home: string, platform: NodeJS.Platform): MovePage {
  switch (lock.kind) {
    case 'held':
      return stopPage(text.lockedTitle, text.locked(home, lock.owner.userData), text, { platform })
    case 'unfinished':
      return {
        title: text.unfinishedTitle,
        paragraphs: [text.unfinished(home, lock.owner.userData)],
        buttons: [
          { label: text.reveal(platform), link: { kind: 'reveal', index: 0 } },
          { label: text.discardMove, link: { kind: 'discard-lock' } },
          { label: text.quit, link: { kind: 'quit' } },
        ],
        reveal: [lock.path],
      }
    case 'unreadable':
      return stopPage(text.journalUnreadableTitle, text.lockUnreadable(lock.path), text, { platform, reveal: lock.path })
    default:
      return lock satisfies never
  }
}

/**
 * The page for a move that stopped because its lock was not this move's: why
 * (the cause), and what can be done besides trying again and quitting.
 * @param text - the sentence set.
 * @param cause - why the lock is not this move's.
 * @param way - abandoning the move (while only its copy changed), or taking it back (once hiding began).
 * @returns the page.
 */
export function lockLostPage(text: MoveText, cause: LockLoss, way: 'abandon' | 'roll-back'): MovePage {
  const why = lockLossText(text, cause)
  return {
    title: why.title,
    paragraphs: [why.sentence, way === 'abandon' ? text.abandonNote : text.rollBackNote],
    buttons: [
      { label: text.retry, link: { kind: 'retry' } },
      way === 'abandon' ? { label: text.abandonMove, link: { kind: 'abandon' } } : { label: text.rollBackMove, link: { kind: 'roll-back' } },
      { label: text.quit, link: { kind: 'quit' } },
    ],
    reveal: [],
  }
}

/**
 * The title and first sentence for why a move's lock is not its own.
 * @param text - the sentence set.
 * @param cause - why.
 * @returns the title and the sentence.
 */
function lockLossText(text: MoveText, cause: LockLoss): { title: string; sentence: string } {
  switch (cause) {
    case 'unreadable':
      return { title: text.lockUncheckedTitle, sentence: text.lockUnchecked }
    case 'missing':
    case 'foreign':
      return { title: text.lockLostTitle, sentence: text.lockLost }
    case 'sibling':
      return { title: text.lockSiblingTitle, sentence: text.lockSibling }
    default:
      return cause satisfies never
  }
}

/**
 * The confirmation before another installation's unfinished move is discarded.
 * @param text - the sentence set.
 * @param lock - the unfinished move's lock.
 * @returns the page.
 */
export function discardLockPage(text: MoveText, lock: Extract<LockState, { kind: 'unfinished' }>): MovePage {
  return {
    title: text.confirmDiscardTitle,
    paragraphs: [text.confirmDiscard(lock.path, lock.owner.userData)],
    buttons: [
      { label: text.confirmDiscardButton, link: { kind: 'confirm' } },
      { label: text.back, link: { kind: 'back' } },
    ],
    reveal: [],
  }
}

/** A progress window's state as the page shows it. */
export interface ProgressView {
  /** The line under the title. */
  line: string
  /** Whether the cancel button is shown. */
  cancellable: boolean
  /** Bytes done over total, 0 to 1; `undefined` for an indeterminate bar. */
  fraction: number | undefined
}

/** How fast the copy has gone so far, for the time left. */
export interface ProgressClock {
  /** When the current stage started, ms. */
  startedAt: number
  stage: MoveProgress['stage'] | undefined
}

/**
 * The progress window's line for one report.
 * @param progress - the report.
 * @param text - the sentence set.
 * @param clock - when the current stage started; updated in place when the stage changes.
 * @param now - the time now, ms.
 * @returns what the page shows.
 */
export function progressView(progress: MoveProgress, text: MoveText, clock: ProgressClock, now: number): ProgressView {
  if (clock.stage !== progress.stage) {
    clock.stage = progress.stage
    clock.startedAt = now
  }
  const cancellable = CANCELLABLE_PHASES.has(progress.phase)
  if (progress.phase === 'rolling-back' || progress.phase === 'cancelling' || progress.phase === 'abandoning') {
    return { line: progress.phase === 'cancelling' ? text.cancelling : text.rollingBack, cancellable: false, fraction: undefined }
  }
  const { done, total } = progress
  const fraction = done !== undefined && total !== undefined && total > 0 ? Math.min(1, done / total) : undefined
  switch (progress.stage) {
    case 'copying': {
      if (done === undefined || total === undefined) return { line: '', cancellable, fraction }
      const elapsed = (now - clock.startedAt) / 1000
      const secondsLeft = done > 0 && elapsed >= 3 ? (total - done) / (done / elapsed) : undefined
      return { line: text.progress(formatBytes(done), formatBytes(total), secondsLeft), cancellable, fraction }
    }
    case 'checking':
      return { line: text.checking, cancellable, fraction }
    case 'finishing':
      return { line: text.finishing, cancellable: false, fraction: undefined }
    default:
      return progress.stage satisfies never
  }
}

/**
 * Escape text for HTML.
 * @param value - the text.
 * @returns it with `& < > "` escaped.
 */
function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/**
 * The shared look of the move's pages.
 * @param appearance - which palette.
 * @returns the style sheet.
 */
function style(appearance: Appearance): string {
  const colors = PALETTES[appearance]
  return `* { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; min-height: 100vh; padding: 28px 30px; display: flex; flex-direction: column; justify-content: center;
    background: ${colors.gradient}; color: ${colors.text}; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif; }
  h1 { margin: 0 0 12px; font-size: 15px; font-weight: 600; }
  p { margin: 0 0 10px; white-space: pre-line; word-break: break-word; user-select: text; }
  .notice { color: ${colors.accent}; }
  .note { margin-top: 12px; font-size: 11px; color: ${colors.muted}; }
  .track { margin: 16px 0 10px; height: 4px; border-radius: 2px; background: ${colors.track}; overflow: hidden; }
  .fill { height: 100%; width: 0; border-radius: 2px; background: ${colors.accent}; transition: width .3s ease; }
  .buttons { margin-top: 16px; display: flex; flex-wrap: wrap; gap: 8px; }
  a.button { display: inline-block; padding: 5px 14px; border-radius: 6px; text-decoration: none; color: ${colors.text};
    border: 1px solid ${colors.muted}; }
  a.button:first-child { background: ${colors.accent}; border-color: ${colors.accent}; color: ${colors.background}; }`
}

/**
 * A page as a `data:` document.
 * @param page - the page.
 * @param appearance - which palette.
 * @returns the URL to load.
 */
export function pageDocument(page: MovePage, appearance: Appearance): string {
  const buttons = page.buttons.map(button => `<a class="button" href="${escapeHtml(moveLinkUrl(button.link))}">${escapeHtml(button.label)}</a>`)
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(page.title)}</title><style>${style(appearance)}</style></head><body>
<h1>${escapeHtml(page.title)}</h1>
${page.notice === undefined ? '' : `<p class="notice">${escapeHtml(page.notice)}</p>`}
${page.paragraphs.map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}
<div class="buttons">${buttons.join('')}</div>
</body></html>`)
}

/**
 * The progress window's document; the main process drives it through
 * `window.__move.show(view)`.
 * @param text - the sentence set.
 * @param appearance - which palette.
 * @returns the URL to load.
 */
export function progressDocument(text: MoveText, appearance: Appearance): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(text.progressTitle)}</title><style>${style(appearance)}</style></head><body>
<h1>${escapeHtml(text.progressTitle)}</h1>
<p id="line"></p>
<div class="track"><div class="fill" id="fill"></div></div>
<div class="note">${escapeHtml(text.progressNote)}</div>
<div class="buttons" id="buttons" hidden><a class="button" href="${moveLinkUrl({ kind: 'cancel' })}">${escapeHtml(text.cancel)}</a></div>
<script>
  window.__move = {
    show(view) {
      document.getElementById('line').textContent = view.line
      const known = typeof view.fraction === 'number'
      document.getElementById('fill').style.width = known ? Math.round(view.fraction * 100) + '%' : '100%'
      document.getElementById('fill').style.opacity = known ? '1' : '.4'
      document.getElementById('buttons').hidden = !view.cancellable
    },
  }
</script></body></html>`)
}
