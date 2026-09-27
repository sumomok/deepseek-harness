/**
 * Names of the visible folders a move leaves for the person to check and
 * delete themselves: an unused copy at the new location after going back, and
 * the original kept after the new location failed its check twice. The name
 * is in the system's language, since the person finds it in Finder or File
 * Explorer; the result records the path, so nothing reads the name back.
 * @module @deepseek-ai/dsh-desktop-shell/move/names
 */

/** Which folder is named. */
export type KeptFolderKind = 'unused' | 'original'

/** The languages folder names come in. */
export type NameLocale = 'zh' | 'en'

/**
 * The language of folder names for a system locale.
 * @param locale - the system locale, as `app.getLocale()` reports it.
 * @returns Chinese on a `zh*` locale, English otherwise.
 */
export function nameLocale(locale: string): NameLocale {
  return locale.startsWith('zh') ? 'zh' : 'en'
}

/**
 * A date as the folder name shows it: local year, month, and day.
 * @param date - the date.
 * @returns `YYYY-MM-DD`.
 */
function localDay(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * The name of a kept folder; the caller tries attempts 1, 2, … until one is free.
 * @param locale - the language.
 * @param kind - which folder.
 * @param date - when it is named.
 * @param attempt - 1 for the plain name; 2 and above add ` (n)`.
 * @returns the folder name, without a directory.
 */
export function keptFolderName(locale: NameLocale, kind: KeptFolderKind, date: Date, attempt: number): string {
  const day = localDay(date)
  const base = locale === 'zh'
    ? `DSH-Data（${kind === 'unused' ? '未使用的副本' : '原来的数据'} ${day}）`
    : `DSH-Data (${kind === 'unused' ? 'unused copy' : 'original data'} ${day})`
  return attempt <= 1 ? base : `${base} (${String(attempt)})`
}
