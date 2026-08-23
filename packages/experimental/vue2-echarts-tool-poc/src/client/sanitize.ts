/**
 * What the browser half changes about a model-supplied option before a real
 * engine paints it inside the shell's own origin.
 *
 * The option is model output. It is not markup and it is not code — the host
 * already rejected anything outside JSON — but three ECharts features turn
 * plain JSON into a document the browser interprets, and each one runs
 * same-origin with the shell:
 *
 * - **Tooltips default to HTML.** A `tooltip.formatter` string is inserted as
 *   markup, so a model-supplied formatter would be a same-origin HTML
 *   injection. `renderMode: 'richText'` makes the engine draw the tooltip on
 *   the canvas instead, where a tag is just characters.
 * - **`graphic` renders arbitrary elements**, including an `image` element
 *   whose `style.image` is any URL. Dropped whole; a chart needs none of it.
 * - **`image://<url>` symbols** load a remote asset for a marker or a legend
 *   icon. Dropped wherever a `symbol` or an `image` string carries the scheme,
 *   which leaves the engine's own built-in symbol names untouched.
 *
 * Everything else passes through: the point of this row is that a model writes
 * ordinary ECharts, and a sanitizer that rewrote the document would break that.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/client/sanitize
 */

/** The scheme that makes an ECharts symbol or image field load a remote asset. */
const IMAGE_SCHEME = 'image://'

/** Keys whose string value ECharts resolves as an asset URL when it carries the scheme. */
const ASSET_KEYS = new Set(['symbol', 'image'])

/** Whether one value is a plain JSON object rather than an array or a primitive. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Copy one value, dropping remote-asset strings wherever they appear. */
function stripAssets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripAssets)
  if (!isRecord(value)) return value
  const copy: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (ASSET_KEYS.has(key) && typeof entry === 'string' && entry.startsWith(IMAGE_SCHEME)) continue
    copy[key] = stripAssets(entry)
  }
  return copy
}

/**
 * Make one model-supplied option safe to paint in the shell's origin.
 * @param option - the option exactly as the tool call carried it.
 * @returns a copy with rich-text tooltips forced, `graphic` removed, and every
 *   remote-asset reference dropped.
 */
export function sanitizeChartOption(option: Record<string, unknown>): Record<string, unknown> {
  const { graphic: _dropped, tooltip, ...rest } = stripAssets(option) as Record<string, unknown>
  return {
    ...rest,
    tooltip: { ...isRecord(tooltip) ? tooltip : {}, renderMode: 'richText' },
  }
}
