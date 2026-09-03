/**
 * The `content_read` row: one line in the transcript saying that the agent
 * looked at the page, and at which page it looked.
 *
 * A read is a glance, not a document. The listing it produced is already in the
 * model's result and is written for the model, not for a reader — so the row
 * states the fact and nothing else, and a failure keeps its explanation in the
 * result rather than repeating it where the user would read it twice.
 *
 * The page's name comes from the tool's own presentation payload, which the
 * host persists with the result, so replay draws the identical line. A call
 * dispatched from inside `run_code` carries no payload — the runtime projects
 * one for top-level calls only — and the row names the column instead.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'

/** Composed props: the toolview runtime share and this package's locale seat. */
export type ContentReadRowProps = ToolCallViewProps & PropsLocale<'contentFrame'>

/** The settled form of a call block, which is the only form carrying an outcome. */
type SettledCall = Extract<ToolCallBlock, { kind: 'tool-result' }>

/**
 * The page name the tool recorded for one settled call.
 * @param meta - the tool's own presentation payload, as the log carries it.
 * @returns the page's title, or undefined when the call recorded none.
 */
function pageOf(meta: unknown): string | undefined {
  const recorded = meta as { page?: unknown } | null | undefined
  return typeof recorded?.page === 'string' && recorded.page.length > 0 ? recorded.page : undefined
}

/**
 * Render one `content_read` call.
 * @param props - the toolview runtime share and the locale seat.
 * @returns the one-line row for this call's stage.
 */
export function ContentReadRow({ block, t }: ContentReadRowProps) {
  if (!('kind' in block)) {
    return <p data-content-read-stage="pending">{t('read.pending')}</p>
  }
  const settled: SettledCall = block
  if (settled.isError) {
    return <p data-content-read-stage="failed">{t('read.failed')}</p>
  }
  const page = pageOf(settled.meta)
  return (
    <p data-content-read-stage="done">
      {page === undefined ? t('read.done.unknown') : t('read.done', { page })}
    </p>
  )
}
