import { useCallback, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import clsx from 'clsx'
import { FoldToggle } from './FoldToggle.tsx'
import { writeClipboard } from './clipboard.ts'
import { CodeToolbar, type CodeToolbarLabels } from './CodeToolbar.tsx'
import cardCss from './CodeCard.module.css'
import {
  grammarForHint,
  highlightLines,
  loadedGrammarCount,
  subscribeGrammars,
  type HighlightSpan,
} from './markdown/highlight.ts'
import { useViewportHighlighting } from './markdown/useViewportHighlighting.ts'
import css from './ReadBlock.module.css'

/**
 * Content lines shown before the height cap collapses the middle. Matches
 * TerminalBlock's default so a long read and a long command output cut at the
 * same place in the same flow.
 */
export const DEFAULT_READ_MAX_LINES = 16

/** One line of the read window: its file line number and its text (no trailing newline). */
export interface ReadBlockLine {
  /** 1-based line number in the file (a window past an offset keeps the file's own numbering). */
  number: number
  /** The line's text, already truncated to the read tool's per-line cap. */
  text: string
}

export interface ReadBlockProps {
  /** Banner label (the file path, or a tool-supplied replacement title); omitted draws no label. */
  label?: string | undefined
  /** The returned window's lines, in file order, each keeping its file line number. */
  lines: readonly ReadBlockLine[]
  /** Localized chrome supplied by the owning render site. */
  labels: ReadBlockLabels
  /** Exact total line count in the file, for the "showing N of M" note when the read is a window. */
  totalLines: number
  /** Grammar hint (a file-extension-derived language id); unknown or absent = plain monospace. */
  lang?: string | undefined
  /** Height cap in content lines before the middle collapses (default {@link DEFAULT_READ_MAX_LINES}). */
  maxLines?: number | undefined
  /** Extra class merged onto the wrapper (callers position; this component draws). */
  className?: string | undefined
}

/** Localized chrome for {@link ReadBlock}. */
export interface ReadBlockLabels extends CodeToolbarLabels {
  window: (shown: number, total: number) => string
  copy: string
  copied: string
  collapseAria: string
  expandAria: (hidden: number) => string
  collapse: string
  expand: (hidden: number) => string
}

function renderSpans(spans: readonly HighlightSpan[]) {
  return spans.map((span, index) => <span key={index} style={span.style}>{span.text}</span>)
}

/**
 * Render a read tool result as a line-numbered, optionally syntax-highlighted
 * file view.
 * @param props - see {@link ReadBlockProps}.
 * @returns the read block element.
 */
export function ReadBlock({
  label,
  labels,
  lines,
  totalLines,
  lang,
  maxLines = DEFAULT_READ_MAX_LINES,
  className,
}: ReadBlockProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const highlighting = useViewportHighlighting(rootRef, lang)
  const [expanded, setExpanded] = useState(false)
  const [copied, setCopied] = useState(false)
  const [wrapped, setWrapped] = useState(false)

  const hidden = lines.length - maxLines
  const capped = hidden > 0 && !expanded
  const headLines = Math.ceil(maxLines / 2)
  const tailLines = maxLines - headLines

  // Subscribe only to this card's own canonical grammar while highlighting is active.
  const grammarId = grammarForHint(lang)
  const grammarIds = useMemo(
    () => (grammarId !== undefined && highlighting ? [grammarId] : []),
    [grammarId, highlighting],
  )
  const subscribe = useCallback(
    (listener: () => void) => subscribeGrammars(grammarIds, listener),
    [grammarIds],
  )
  const getSnapshot = useCallback(
    () => loadedGrammarCount(grammarIds),
    [grammarIds],
  )
  const loaded = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const headSlice = useMemo(
    () => (capped ? lines.slice(0, headLines) : lines),
    [capped, lines, headLines],
  )
  const tailSlice = useMemo(
    () => (capped && tailLines > 0 ? lines.slice(lines.length - tailLines) : []),
    [capped, lines, tailLines],
  )
  // Tokenize visible head and tail slices separately when collapsed so an
  // unclosed construct in the head never bleeds across the hidden middle.
  const headHighlighted = useMemo(
    () => (highlighting && headSlice.length > 0
      ? highlightLines(headSlice.map(line => line.text).join('\n'), lang)
      : undefined),
    [highlighting, headSlice, lang, loaded],
  )
  const tailHighlighted = useMemo(
    () => (highlighting && tailSlice.length > 0
      ? highlightLines(tailSlice.map(line => line.text).join('\n'), lang)
      : undefined),
    [highlighting, tailSlice, lang, loaded],
  )

  const onCopy = useCallback(() => {
    if (copied) return
    void writeClipboard(lines.map(line => line.text).join('\n')).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => { setCopied(false) }, 1000)
    })
  }, [copied, lines])

  const onToggle = useCallback(() => { setExpanded(value => !value) }, [])

  // A read is a window when its returned lines are fewer than the file's total;
  // the note states that so a reader is not misled that the file ends here.
  const windowed = lines.length < totalLines

  const renderRows = (
    slice: readonly ReadBlockLine[],
    spansByLine: readonly (readonly HighlightSpan[])[] | undefined,
  ) =>
    slice.map((line, index) => {
      const spans = spansByLine?.[index]
      return (
        <div key={line.number} className={css.line}>
          <span className={css.gutter} aria-hidden>{line.number}</span>
          <span className={css.content}>{spans === undefined ? line.text : renderSpans(spans)}</span>
        </div>
      )
    })

  const gutterDigits = lines.reduce((digits, line) => Math.max(digits, String(line.number).length), 3)
  const gutterStyle = { '--dsl-read-gutter': `${gutterDigits}ch` } as CSSProperties

  return (
    <div ref={rootRef} className={clsx(cardCss.card, css.block, className)} data-read="" data-code-wrap={wrapped} style={gutterStyle}>
      <CodeToolbar
        lang={lang} title={label} status={windowed ? labels.window(lines.length, totalLines) : undefined}
        labels={labels} copyLabel={labels.copy} copiedLabel={labels.copied} copied={copied} wrapped={wrapped}
        // Empty files must not replace the clipboard with empty text.
        onCopy={lines.length > 0 ? onCopy : undefined} onWrap={() => { setWrapped(value => !value) }}
      />
      <div className={cardCss.body}>
        {renderRows(headSlice, headHighlighted)}
        {hidden > 0 && (
          <FoldToggle
            className={css.expand}
            expanded={expanded}
            hidden={hidden}
            labels={labels}
            onToggle={onToggle}
          />
        )}
        {tailSlice.length > 0 && renderRows(tailSlice, tailHighlighted)}
      </div>
    </div>
  )
}
