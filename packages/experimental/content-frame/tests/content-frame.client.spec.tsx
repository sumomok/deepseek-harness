// @vitest-environment jsdom
/**
 * ContentFrame under its two-share props form. The assertions are the
 * user-visible ones plus the one attribute decision the package's trust
 * posture rests on: the frame carries no `sandbox`, which is what keeps the
 * hosted document same-origin with the shell.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { CONTENT_APP_SRC } from '../src/route.ts'
import { zh } from '../src/client/locales.ts'

/** Render the frame with the face the plugin injects. */
function mountFrame(src: string = CONTENT_APP_SRC): HTMLIFrameElement {
  const props = { src, t: makeTranslate(zh) } as unknown as ContentFrameProps
  const view = render(<ContentFrame {...props} />)
  return view.container.firstElementChild as HTMLIFrameElement
}

afterEach(() => {
  cleanup()
})

describe('ContentFrame', () => {
  it('points one iframe at the injected same-origin URL', () => {
    const frame = mountFrame()
    expect(frame.tagName).toBe('IFRAME')
    // The attribute, not the resolved `src` property: the value must stay the
    // relative path the plugin injected, so the frame follows the dsh origin.
    expect(frame.getAttribute('src')).toBe(CONTENT_APP_SRC)
  })

  it('labels the frame from the locale seat', () => {
    expect(mountFrame().title).toBe(zh['frame.title'])
  })

  it('carries no sandbox attribute, keeping the hosted document same-origin', () => {
    expect(mountFrame().hasAttribute('sandbox')).toBe(false)
  })

  it('exposes the frame under a stable attribute for assembled coverage', () => {
    expect(mountFrame().hasAttribute('data-content-frame')).toBe(true)
  })

  it('renders whatever URL it is given rather than composing one', () => {
    expect(mountFrame('/other-app/').getAttribute('src')).toBe('/other-app/')
  })
})
