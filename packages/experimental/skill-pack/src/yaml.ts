/**
 * The one YAML reading both a pack's frontmatter and its view files need: a
 * document that must be a mapping, and that is a pack author's text rather
 * than this repository's own, so a syntax error is an answer and not a throw.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/yaml
 */

import { parse } from 'yaml'

/**
 * Parse one YAML document that must be a mapping.
 * @param text - the YAML source.
 * @returns the mapping, or `undefined` when the source does not parse or is not a mapping.
 */
export function parseYamlMapping(text: string): Record<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = parse(text)
  } catch {
    // Swallowed here and nowhere else: this is pack-author text, and every
    // caller reports a refusal as the pack's own inactive state.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return parsed as Record<string, unknown>
}
