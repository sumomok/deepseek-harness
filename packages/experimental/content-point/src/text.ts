/**
 * The model text for the points one user message carries: one paragraph per
 * reference this plugin recorded, in the order the message holds them, written
 * from the logged `data` alone. A DataPage row is never written, whatever the
 * logged `data` holds, so a cell's, a row's or a row operation's values reach
 * the model through neither the reference nor this text.
 * @module @deepseek-ai/dsh-experimental-content-point/text
 */

import { chipLabel, parsePointData, renderPointText, renderUnreadablePoint } from '@haoran/dsh-point-anchor'
import type { PointData } from '@haoran/dsh-point-anchor'
import { BLOCK_FORMAT, blockKey, blockLabel, parseBlockData } from './block.ts'
import type { BlockData } from './block.ts'

/** The `PromptReference.source` this plugin files every point under. */
export const POINT_SOURCE = 'content-point'

/** One recorded reference, the fields this module reads. */
export interface RecordedReference {
  readonly source: string
  readonly label: string
  readonly data: unknown
}

/** One reference as the model text writes it. */
interface Written {
  /** The paragraph. */
  readonly text: string
  /** What the reference points at, for the row's one-line summary. */
  readonly label: string
}

/** What one user message's points add for the model. */
export interface PointNotice {
  /** The model text. */
  readonly text: string
  /** The labels of the points, in order, for the context row's one-line account. */
  readonly labels: readonly string[]
}

/**
 * A description without its DataPage row, which no model text carries.
 * @param point - the description as read.
 * @returns the description without `row` and `rowOmitted`.
 */
function withoutRow(point: PointData): PointData {
  return {
    v: point.v,
    anchorFormat: point.anchorFormat,
    what: point.what,
    ...point.anchor !== undefined ? { anchor: point.anchor } : {},
    ...point.unanchored !== undefined ? { unanchored: point.unanchored } : {},
    shown: point.shown,
  }
}

/**
 * The paragraph of a block reference.
 * @param data - the reference.
 * @returns the paragraph.
 */
function blockText(data: BlockData): string {
  const shown = [data.shown.page, data.shown.target].filter(value => value !== undefined)
  return [
    `用户在内容栏里指着「${blockLabel(data)}」这一整块。`,
    `锚点：\`${blockKey(data)}\``,
    ...shown.length > 0 ? [`显示：${shown.join(' · ')}`] : [],
  ].join('\n')
}

/**
 * Write one reference this plugin recorded.
 * @param data - its logged `data`.
 * @param label - its logged label, which the summary falls back to for a reference this build cannot read.
 * @returns the paragraph and the label.
 */
function written(data: unknown, label: string): Written {
  if (typeof data === 'object' && data !== null && 'kind' in data) {
    const block = parseBlockData(data)
    if (block.ok) return { text: blockText(block.value), label: blockLabel(block.value) }
    const text = block.problem.kind === 'format'
      ? `用户在内容栏里指了一整块，但这条引用的格式 ${String(block.problem.stated)} 本版本读不了（本版本读格式 ${String(BLOCK_FORMAT)}）。`
      : '用户在内容栏里指了一整块，但这条引用的内容本版本读不了。'
    return { text, label }
  }
  const point = parsePointData(data)
  if (point.ok) return { text: renderPointText(withoutRow(point.value)), label: chipLabel(point.value) }
  if (point.reads !== undefined) {
    return { text: renderUnreadablePoint({ ...point.stated !== undefined ? { stated: point.stated } : {}, reads: point.reads }), label }
  }
  return { text: '用户在内容栏里指了一处，但这条引用的内容本版本读不了。', label }
}

/**
 * The model text for the references this plugin recorded on one user message,
 * at most `limit` of them, the first ones; another owner's references are not
 * this plugin's to write.
 * @param references - the message's recorded references, in order.
 * @param limit - the most references written; the protocol's bound per prompt.
 * @returns the notice, or undefined when the message carries none of this plugin's.
 */
export function pointNotice(references: readonly RecordedReference[], limit: number): PointNotice | undefined {
  const ours = references.filter(reference => reference.source === POINT_SOURCE).slice(0, limit)
  if (ours.length === 0) return undefined
  const parts = ours.map(reference => written(reference.data, reference.label))
  return { text: parts.map(part => part.text).join('\n\n'), labels: parts.map(part => part.label) }
}
