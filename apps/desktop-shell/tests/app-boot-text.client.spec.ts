// @vitest-environment jsdom
/**
 * The shell's restatement of the served UI's loading page: its selectors are
 * checked against the web client's own `BootPage`, so a change to that page's
 * structure fails here rather than showing English text in the window.
 * @module
 */

import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../../../packages/client/web/src/boot-page.ts'
import { APP_BOOT_SELECTORS, APP_BOOT_TEXT, appBootCss, restateAppBootPage } from '../src/app-boot-text.ts'

afterEach(() => { document.body.innerHTML = '' })

/**
 * Mount the web client's loading page.
 * @returns the page.
 */
function mount(): BootPage {
  const container = document.createElement('div')
  document.body.append(container)
  return new BootPage(container)
}

/**
 * The text of every element a selector matches.
 * @param selector - the selector.
 * @returns their texts, in document order.
 */
function texts(selector: string): string[] {
  return [...document.querySelectorAll(selector)].map(element => element.textContent)
}

describe('the loading page selectors', () => {
  it('each select exactly the text they replace while loading', () => {
    mount()
    expect(texts(APP_BOOT_SELECTORS.wordmark)).toEqual(['HARNESS'])
    expect(texts(APP_BOOT_SELECTORS.loading)).toEqual(['Loading plugins…'])
    expect(texts(APP_BOOT_SELECTORS.failed)).toEqual([])
  })

  it('select the failure title, and not the failed entries, once a plugin failed', () => {
    const page = mount()
    page.setState('broken-plugin', 'failed')
    expect(texts(APP_BOOT_SELECTORS.wordmark)).toEqual(['HARNESS'])
    expect(texts(APP_BOOT_SELECTORS.loading)).toEqual([])
    expect(texts(APP_BOOT_SELECTORS.failed)).toEqual(['Failed to load plugins'])
  })

  it('match nothing on a page that is not the loading page', () => {
    document.body.innerHTML = '<main><div><div>chat</div><div>list</div></div></main>'
    for (const selector of Object.values(APP_BOOT_SELECTORS)) expect(texts(selector)).toEqual([])
  })
})

describe('appBootCss', () => {
  it('draws the product name and the shell language\'s texts in place of the page\'s own', () => {
    const zh = appBootCss('zh')
    expect(zh).toContain(`${APP_BOOT_SELECTORS.wordmark}::after { content: "北冥"`)
    expect(zh).toContain(`${APP_BOOT_SELECTORS.loading}::after { content: "正在加载插件…"`)
    expect(zh).toContain(`${APP_BOOT_SELECTORS.failed}::after { content: "插件加载失败"`)
    expect(zh).toContain(`${APP_BOOT_SELECTORS.wordmark} { font-size: 0 !important;`)
    expect(appBootCss('en')).toContain(`content: "${APP_BOOT_TEXT.en.wordmark}"`)
    expect(appBootCss('en')).not.toContain('HARNESS')
  })

  it('parses as three pairs of rules', () => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(appBootCss('zh'))
    expect(sheet.cssRules).toHaveLength(6)
  })
})

describe('restateAppBootPage', () => {
  it('inserts the stylesheet on every committed navigation and every DOM-ready', async () => {
    const contents = new EventEmitter() as EventEmitter & { inserted: string[]; insertCSS(css: string): Promise<string> }
    contents.inserted = []
    contents.insertCSS = async (css) => {
      contents.inserted.push(css)
      if (contents.inserted.length === 2) throw new Error('page gone')
      return 'key'
    }
    restateAppBootPage(contents, 'css')
    contents.emit('did-navigate')
    contents.emit('dom-ready')
    contents.emit('did-navigate')
    await Promise.resolve()
    expect(contents.inserted).toEqual(['css', 'css', 'css'])
  })
})
