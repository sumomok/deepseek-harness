/**
 * Reading one view file a pack declares.
 *
 * A view file says which entry it owns (`id`), what the user reads on it
 * (`title`), what to draw (`spec`) and the values the pack fills that drawing
 * with (`params`). Only the first two are read here. `spec` and `params` are
 * carried verbatim: the component catalog owns what a spec may contain, and a
 * second opinion on it in this package would be a second answer that can drift
 * from the one a call is judged by.
 *
 * A file this module refuses makes its whole pack inactive, so the reason it
 * comes back with names the file and says what was wrong with it.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/views
 */

import type { PackDocumentField, PackViewResult } from './types.ts'
import { parseYamlMapping } from './yaml.ts'

/**
 * The keys {@link parsePackView} reads, in the order it reads them: `id` and
 * `title` must be non-empty text, `spec` must be present, and `params`, where
 * written, must be a mapping. Any other key in a view file is ignored.
 */
export const PACK_VIEW_FIELDS: readonly PackDocumentField[] = [
  { path: 'id', required: true },
  { path: 'title', required: true },
  { path: 'spec', required: true },
  { path: 'params', required: false },
]

/**
 * Parse one view file's text.
 * @param path - the pack-relative path the manifest declared, carried into the result so a refusal names the file.
 * @param raw - the file's complete text.
 * @returns the view, or the reason the file is not one.
 */
export function parsePackView(path: string, raw: string): PackViewResult {
  const data = parseYamlMapping(raw)
  if (data === undefined) return { ok: false, path, reason: 'is not a YAML mapping' }
  const id = data.id
  if (typeof id !== 'string' || id.length === 0) return { ok: false, path, reason: 'has no id' }
  const title = data.title
  if (typeof title !== 'string' || title.length === 0) return { ok: false, path, reason: 'has no title' }
  if (!('spec' in data)) return { ok: false, path, reason: 'has no spec' }
  const params = data.params
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
    return { ok: false, path, reason: 'has params that are not a mapping' }
  }
  return {
    ok: true,
    path,
    view: {
      id,
      title,
      spec: data.spec,
      params: (params ?? {}) as Readonly<Record<string, unknown>>,
    },
  }
}
