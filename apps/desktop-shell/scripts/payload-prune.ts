/**
 * Which Markdown the packaged server payload drops.
 *
 * The payload prunes documentation to save files and path depth, but Markdown
 * is not automatically documentation: shipped config trees carry runtime
 * instruction files (`SKILL.md`), and a plugin's locale `meta.detail` may name a
 * localized description such as `docs/DETAIL.zh.md`. Only names that are a
 * documentation name are pruned; a language suffix does not make one.
 */

/** Documentation file names, before an optional language segment and `.md`. */
const DOCUMENTATION_NAMES =
  /^(readme|changelog|history|security|contributing|code_of_conduct|governance|authors|maintainers|backers|sponsors)\b/

/**
 * Whether a payload file is documentation Markdown the package drops.
 * @param name - the file's basename.
 * @returns true for `README.md`, `README.zh.md`, `CHANGELOG.md`, and the like.
 */
export function prunesDocumentationMarkdown(name: string): boolean {
  const lower = name.toLowerCase()
  if (!lower.endsWith('.md') && !lower.endsWith('.markdown')) return false
  return DOCUMENTATION_NAMES.test(lower)
}
