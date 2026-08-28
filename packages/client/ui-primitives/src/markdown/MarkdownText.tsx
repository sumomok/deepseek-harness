/**
 * Untrusted assistant-Markdown renderer over the direct mdast pipeline:
 * `parse.ts` grammars, the incremental streaming parser, and `render.tsx`.
 * While a message streams, all but the trailing two blocks freeze as cached
 * React elements and only the source tail behind them re-parses per chunk,
 * so per-chunk work tracks the tail size instead of the whole reply. Frozen
 * blocks keep their source-offset keys when they cross the freeze boundary,
 * so React reconciles instead of remounting. Known deviation while
 * streaming: a reference-style link or footnote whose definition sits on the
 * other side of the freeze boundary renders literally until the settled
 * full parse self-heals it.
 */

import { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { IncrementalMarkdownParser } from './incremental.ts'
import { parseGfm, parseGfmWithMath } from './parse.ts'
import {
  collectReferenceTargets, createReferenceTargets, renderBlocks, renderFootnoteSection,
  wrapBlockChildren,
} from './render.tsx'
import type {
  MarkdownCodeLabels, MarkdownFileMentions, MarkdownProseReferents, MarkdownRenderContext, ReferenceTargets,
} from './render.tsx'
import 'katex/dist/katex.min.css'
import css from './MarkdownText.module.css'

export type { MarkdownCodeLabels, MarkdownFileMentions, MarkdownProseReferents, MarkdownProseSpan } from './render.tsx'

/** One settled full render: parse with math, resolve references, append the footnote section. */
function renderSettled(
  text: string,
  codeLabels: MarkdownCodeLabels | undefined,
  fileMentions: MarkdownFileMentions | undefined,
  referents: MarkdownProseReferents | undefined,
): ReactNode[] {
  const root = parseGfmWithMath(text)
  const targets = createReferenceTargets()
  collectReferenceTargets(root.children, targets)
  const context: MarkdownRenderContext = {
    streaming: false,
    codeLabels,
    fileMentions,
    referents,
    targets,
    footnoteOrder: [],
    footnoteCounts: new Map(),
  }
  const blocks = wrapBlockChildren(
    renderBlocks(root.children.map((node, index) => ({ node, key: index })), context),
    false,
  )
  const section = renderFootnoteSection(context)
  return section === null ? blocks : [...blocks, '\n', section]
}

/**
 * Streaming render state for one growing message: the incremental parser,
 * the frozen blocks' cached elements, and the reference/footnote state their
 * rendering consumed (footnote numbering assigned to frozen references is
 * final, so the tail continues from a copy of it each frame).
 */
class StreamingRenderer {
  private readonly parser = new IncrementalMarkdownParser(parseGfm)
  private generation = -1
  private frozenCount = 0
  private frozenElements: ReactNode[] = []
  private frozenTargets: ReferenceTargets = createReferenceTargets()
  private frozenFootnoteOrder: string[] = []
  private frozenFootnoteCounts = new Map<string, number>()
  private lastText: string | null = null
  private lastRendered: ReactNode[] = []

  /** @param codeLabels - Fence copy labels baked into cached elements; the owner replaces the renderer when they change. */
  constructor(private readonly codeLabels: MarkdownCodeLabels | undefined) {}

  /**
   * Render the current accumulated text. Idempotent per text value, so React
   * may re-execute the calling render freely.
   * @param text - The full accumulated markdown source.
   * @returns Frozen elements, re-rendered tail, and the footnote section.
   */
  render(text: string): ReactNode[] {
    if (text === this.lastText) return this.lastRendered
    const { frozen, tail, generation } = this.parser.update(text)
    if (generation !== this.generation) {
      this.generation = generation
      this.frozenCount = 0
      this.frozenElements = []
      this.frozenTargets = createReferenceTargets()
      this.frozenFootnoteOrder = []
      this.frozenFootnoteCounts = new Map()
    }
    const newlyFrozen = frozen.slice(this.frozenCount)
    collectReferenceTargets(newlyFrozen.map(block => block.node), this.frozenTargets)
    // Targets visible this frame: everything frozen so far plus the current
    // tail parse — a newly frozen block's references resolved against the
    // same parse tree its definitions came from.
    const frameTargets: ReferenceTargets = {
      definitions: new Map(this.frozenTargets.definitions),
      footnotes: new Map(this.frozenTargets.footnotes),
    }
    collectReferenceTargets(tail.map(block => block.node), frameTargets)
    if (newlyFrozen.length > 0) {
      const frozenContext: MarkdownRenderContext = {
        streaming: true,
        codeLabels: this.codeLabels,
        fileMentions: undefined,
        referents: undefined,
        targets: frameTargets,
        footnoteOrder: this.frozenFootnoteOrder,
        footnoteCounts: this.frozenFootnoteCounts,
      }
      // Separator newlines are cached alongside the elements so the
      // assembled children match the settled pipeline's block wrapping.
      const batch = [...this.frozenElements]
      for (const element of renderBlocks(newlyFrozen, frozenContext)) {
        if (batch.length > 0) batch.push('\n')
        batch.push(element)
      }
      this.frozenElements = batch
      this.frozenCount = frozen.length
    }
    const tailContext: MarkdownRenderContext = {
      streaming: true,
      codeLabels: this.codeLabels,
      fileMentions: undefined,
      referents: undefined,
      targets: frameTargets,
      footnoteOrder: [...this.frozenFootnoteOrder],
      footnoteCounts: new Map(this.frozenFootnoteCounts),
    }
    const children = [...this.frozenElements]
    for (const element of renderBlocks(tail, tailContext)) {
      if (children.length > 0) children.push('\n')
      children.push(element)
    }
    const section = renderFootnoteSection(tailContext)
    if (section !== null) children.push('\n', section)
    this.lastText = text
    this.lastRendered = children
    return this.lastRendered
  }
}

/**
 * Re-render the caller once per `referents.subscribe` verification tick, by
 * returning an incrementing counter the caller folds into its memo key.
 * Closes the settle-rerender gap: a settled message's `useMemo` cache would
 * otherwise never re-invoke `scan`/`resolveLink` after the message settles,
 * so a candidate that verifies moments later (the host `stat` batch is
 * asynchronous) stayed plain text until a full page refresh remounted the
 * component and re-scanned against the by-then-verified index.
 * @param referents - the current referents face; re-subscribes whenever its identity changes.
 * @returns a counter that increments on every tick; stable (never increments) with no `subscribe`.
 */
function useReferentsRevision(referents: MarkdownProseReferents | undefined): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const subscribe = referents?.subscribe
    if (subscribe === undefined) return
    return subscribe(() => { setRevision(r => r + 1) })
  }, [referents])
  return revision
}

/**
 * Render untrusted assistant-authored Markdown as semantic React elements.
 * @param props - Markdown source text preserved by the session projection;
 * `streaming` renders fences and TeX plain (highlighting and KaTeX land on
 * the finalize swap) and parses incrementally across chunks; `codeLabels`
 * forwards localized copy-button labels to fence CodeBlocks — pass a
 * reference-stable object (memoized per locale revision), because a new
 * identity discards the streaming render cache mid-message. `fileMentions`
 * links inline-code tokens its resolver recognizes as real files; `referents`
 * additionally scans plain prose text (and whatever inline code
 * `fileMentions` leaves unclaimed) for clickable references. Both are the
 * same single streaming gate — they apply to settled renders only, because a
 * streaming message's vocabulary is not final and frozen cached elements
 * must not bake in handlers that could go stale.
 * @returns A GFM document with TeX math rendered through KaTeX; raw HTML,
 * relative links, and unsafe protocols are disabled, while absolute HTTP(S)
 * images render directly.
 */
export const MarkdownText = memo(function MarkdownText({ text, streaming = false, codeLabels, fileMentions, referents }: {
  text: string
  streaming?: boolean
  codeLabels?: MarkdownCodeLabels | undefined
  fileMentions?: MarkdownFileMentions | undefined
  referents?: MarkdownProseReferents | undefined
}) {
  const streamRef = useRef<StreamingRenderer | null>(null)
  const streamLabelsRef = useRef<MarkdownCodeLabels | undefined>(codeLabels)
  const referentsRevision = useReferentsRevision(referents)
  const children = useMemo(() => {
    if (!streaming) {
      streamRef.current = null
      return renderSettled(text, codeLabels, fileMentions, referents)
    }
    if (streamRef.current === null || streamLabelsRef.current !== codeLabels) {
      streamRef.current = new StreamingRenderer(codeLabels)
      streamLabelsRef.current = codeLabels
    }
    return streamRef.current.render(text)
    // referentsRevision itself is never read in this body; it rides the
    // dependency array purely to invalidate the memo on a verification
    // tick, the same technique `text`/`streaming` already use for their own changes.
  }, [text, streaming, codeLabels, fileMentions, referents, referentsRevision])
  return <div className={css.markdown}>{children}</div>
})
