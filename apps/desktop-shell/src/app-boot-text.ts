/**
 * The served UI's own loading page, restated in the shell's language and under
 * the product name.
 *
 * Between the shell's boot page and the first rendered view, the window shows
 * the web client's framework-free loading page
 * (`packages/client/web/src/boot-page.ts`): a `HARNESS` wordmark, a spinner,
 * `Loading plugins…`, and on a failed plugin load `Failed to load plugins`.
 * That page is drawn before the client's locale plugin runs, so its text is
 * fixed English. The shell does not change that package; it inserts a
 * stylesheet into each page the window loads that hides those texts and draws
 * its own in their place. The stylesheet selects by the page's `data-dsh-boot`
 * and `data-dsh-boot-spinner` attributes and element order, never by its
 * generated class names, and matches nothing on any other page.
 * @module @deepseek-ai/dsh-desktop-shell/app-boot-text
 */

/**
 * The loading page's texts in each shell language, keyed like the menu labels
 * in [[@deepseek-ai/dsh-desktop-shell/menu-text]].
 */
export const APP_BOOT_TEXT = {
  zh: { wordmark: '北冥', loading: '正在加载插件…', failed: '插件加载失败' },
  en: { wordmark: 'Beiming', loading: 'Loading plugins…', failed: 'Failed to load plugins' },
} as const

/**
 * Where each replaced text sits on the loading page: the wordmark is the first
 * child of the page's card, the loading hint follows the spinner, and the
 * failure title is the first line of the card's second child when that child
 * is not the spinner.
 */
export const APP_BOOT_SELECTORS = {
  wordmark: '[data-dsh-boot] > div > div:first-child',
  loading: '[data-dsh-boot] > div > [data-dsh-boot-spinner] + div',
  failed: '[data-dsh-boot] > div > div:nth-child(2):not([data-dsh-boot-spinner]) > div:first-child',
} as const

/**
 * One replacement rule pair: the element's own text is drawn at size 0 and the
 * replacement is drawn by `::after` at the size the page gives that text.
 * @param selector - the element whose text is replaced.
 * @param text - the replacement.
 * @param size - the page's font size and line height for that element, in px,
 * and its letter spacing in em, which must be restated because an `em` value
 * on the element itself now resolves against size 0.
 * @returns the two rules.
 */
function replaceText(selector: string, text: string, size: { font: number; line: number; spacing?: number }): string {
  const spacing = size.spacing === undefined ? '' : ` letter-spacing: ${String(size.spacing)}em;`
  return `${selector} { font-size: 0 !important; line-height: 0 !important; }\n`
    + `${selector}::after { content: ${JSON.stringify(text)}; font-size: ${String(size.font)}px; line-height: ${String(size.line)}px;${spacing} }\n`
}

/**
 * The stylesheet that restates the loading page.
 * @param language - the shell language for this launch.
 * @returns CSS for `webContents.insertCSS`.
 */
export function appBootCss(language: keyof typeof APP_BOOT_TEXT): string {
  const text = APP_BOOT_TEXT[language]
  return replaceText(APP_BOOT_SELECTORS.wordmark, text.wordmark, { font: 16, line: 24, spacing: 0.08 })
    + replaceText(APP_BOOT_SELECTORS.loading, text.loading, { font: 12, line: 18 })
    + replaceText(APP_BOOT_SELECTORS.failed, text.failed, { font: 14, line: 22 })
}

/** The part of Electron's `WebContents` the override uses. */
export interface StyledContents {
  /**
   * Add a stylesheet to the current page.
   * @param css - the stylesheet.
   * @returns settles once inserted; rejects when the page is gone.
   */
  insertCSS(css: string): Promise<string>
  on(event: 'did-navigate' | 'dom-ready', listener: () => void): unknown
}

/**
 * Insert the stylesheet into every page the window shows. `did-navigate` fires
 * once the new document is committed, before the client's scripts have drawn
 * the loading page in the ordinary case; `dom-ready` inserts it again in case
 * the first insert reached the document too early to stay. Two copies of the
 * same rules change nothing.
 * @param contents - the window's web contents.
 * @param css - from [[appBootCss]].
 */
export function restateAppBootPage(contents: StyledContents, css: string): void {
  const insert = (): void => {
    contents.insertCSS(css).catch(() => {
      // The page was replaced or the window closed while inserting; the next
      // page gets its own insert.
    })
  }
  contents.on('did-navigate', insert)
  contents.on('dom-ready', insert)
}
