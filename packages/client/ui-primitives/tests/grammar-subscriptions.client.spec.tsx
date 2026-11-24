// @vitest-environment jsdom

import { Profiler } from 'react'
import { act, cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadBlock } from '../src/ReadBlock.tsx'
import { useCodeHighlighter } from '../src/code-highlighting.ts'
import { CodeBlock } from '../src/markdown/CodeBlock.tsx'
import {
  highlightLines, loadedGrammarCount, subscribeGrammars,
} from '../src/markdown/highlight.ts'
import { markdownLabels, readBlockLabels } from './labels.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

class StubIntersectionObserver implements IntersectionObserver {
  static instances: StubIntersectionObserver[] = []

  readonly root = null
  readonly rootMargin = ''
  readonly scrollMargin = ''
  readonly thresholds: readonly number[] = []
  readonly observed = new Set<Element>()

  constructor(private readonly callback: IntersectionObserverCallback) {
    StubIntersectionObserver.instances.push(this)
  }

  observe(element: Element): void {
    this.observed.add(element)
  }

  unobserve(element: Element): void {
    this.observed.delete(element)
  }

  disconnect(): void {
    this.observed.clear()
  }

  takeRecords(): IntersectionObserverEntry[] {
    return []
  }

  intersect(element: Element, isIntersecting: boolean): void {
    const rect = new DOMRect()
    this.callback(
      [{
        boundingClientRect: rect,
        intersectionRatio: isIntersecting ? 1 : 0,
        intersectionRect: rect,
        isIntersecting,
        rootBounds: null,
        target: element,
        time: 0,
      }],
      this,
    )
  }
}

describe('per-language grammar subscriptions', () => {
  it('isolates per-language listeners, cleans up buckets on dispose, and skips ready grammars', async () => {
    expect(loadedGrammarCount(['typescript', 'shellscript', 'json'])).toBe(3)
    expect(loadedGrammarCount(['rust', 'python'])).toBe(0)

    const bootListener = vi.fn()
    const stopBoot = subscribeGrammars(['typescript'], bootListener)

    const rustA = vi.fn()
    const rustB = vi.fn()
    const stopRustA = subscribeGrammars(['rust'], rustA)
    const stopRustB = subscribeGrammars(['rust'], rustB)
    // Removing one listener leaves the shared bucket intact for remaining subscribers.
    stopRustA()

    const scalaListener = vi.fn()
    const stopScala = subscribeGrammars(['scala'], scalaListener)
    // Disposing the last listener removes the bucket completely.
    stopScala()

    const pythonListener = vi.fn()
    const stopPython = subscribeGrammars(['python'], pythonListener)

    expect(highlightLines('fn main() {}', 'rust')).toBeUndefined()
    await waitFor(() => { expect(rustB).toHaveBeenCalledTimes(1) }, { timeout: 5_000 })

    expect(rustA).not.toHaveBeenCalled()
    expect(bootListener).not.toHaveBeenCalled()
    expect(pythonListener).not.toHaveBeenCalled()
    expect(loadedGrammarCount(['rust'])).toBe(1)
    expect(loadedGrammarCount(['python'])).toBe(0)

    // Disposing after the bucket was drained is a safe no-op.
    stopRustB()
    stopBoot()

    // Already-loaded lazy grammars are skipped on subsequent subscriptions.
    const lateRust = vi.fn()
    const stopLateRust = subscribeGrammars(['rust'], lateRust)
    stopLateRust()

    expect(highlightLines('print(1)', 'python')).toBeUndefined()
    await waitFor(() => { expect(pythonListener).toHaveBeenCalledTimes(1) }, { timeout: 5_000 })
    expect(lateRust).not.toHaveBeenCalled()
    expect(loadedGrammarCount(['python'])).toBe(1)
    stopPython()
  })

  it('fans out embedded sub-grammars and deduplicates listeners subscribed to both parent and child', async () => {
    const htmlListener = vi.fn()
    const cssListener = vi.fn()
    const combinedListener = vi.fn()
    const unrelatedListener = vi.fn()

    const stopHtml = subscribeGrammars(['html'], htmlListener)
    const stopCss = subscribeGrammars(['css'], cssListener)
    const stopCombined = subscribeGrammars(['vue', 'html'], combinedListener)
    const stopUnrelated = subscribeGrammars(['dart'], unrelatedListener)

    expect(loadedGrammarCount(['vue', 'html', 'css'])).toBe(0)
    expect(highlightLines('<template><div /></template>', 'vue')).toBeUndefined()

    await waitFor(() => { expect(combinedListener).toHaveBeenCalledTimes(1) }, { timeout: 10_000 })
    expect(htmlListener).toHaveBeenCalledTimes(1)
    expect(cssListener).toHaveBeenCalledTimes(1)
    expect(unrelatedListener).not.toHaveBeenCalled()
    expect(loadedGrammarCount(['vue', 'html', 'css'])).toBe(3)
    expect(highlightLines('<div>ok</div>', 'html')).not.toBeUndefined()
    expect(highlightLines('.a { color: red; }', 'css')).not.toBeUndefined()

    stopHtml()
    stopCss()
    stopCombined()
    stopUnrelated()
  })

  it('prevents unrelated grammar loads from re-rendering CodeBlock, ReadBlock, diff fences, and useCodeHighlighter', async () => {
    let tsCodeRenders = 0
    let tomlCodeRenders = 0
    let tsReadRenders = 0
    let diffRenders = 0

    const yamlDiff = [
      '--- a/config.yaml',
      '+++ b/config.yaml',
      '@@ -1 +1 @@',
      '-enabled: false',
      '+enabled: true',
    ].join('\n')

    const view = render(
      <>
        <Profiler id="ts-code" onRender={() => { tsCodeRenders += 1 }}>
          <CodeBlock code="const stable = 1" lang="ts" {...markdownLabels.code} />
        </Profiler>
        <Profiler id="toml-code" onRender={() => { tomlCodeRenders += 1 }}>
          <CodeBlock code={'title = "app"'} lang="toml" {...markdownLabels.code} />
        </Profiler>
        <Profiler id="ts-read" onRender={() => { tsReadRenders += 1 }}>
          <ReadBlock
            label="a.ts"
            lang="ts"
            lines={[{ number: 1, text: 'const x = 1' }]}
            totalLines={1}
            labels={readBlockLabels}
          />
        </Profiler>
        <Profiler id="yaml-diff" onRender={() => { diffRenders += 1 }}>
          <CodeBlock code={yamlDiff} lang="diff" showHeader={false} {...markdownLabels.code} />
        </Profiler>
      </>,
    )

    const tsHook = renderHook(() => useCodeHighlighter('ts'))
    const nixHook = renderHook(() => useCodeHighlighter('nix'))
    const initialTsFn = tsHook.result.current
    const initialNixFn = nixHook.result.current

    // Wait for toml + yaml (triggered by the mounted blocks) to settle first.
    await waitFor(() => {
      expect(loadedGrammarCount(['toml', 'yaml'])).toBe(2)
    }, { timeout: 10_000 })
    expect(view.container.querySelectorAll('pre code span[style*="--shiki-"]').length).toBeGreaterThan(0)

    const tsCodeBefore = tsCodeRenders
    const tomlCodeBefore = tomlCodeRenders
    const tsReadBefore = tsReadRenders
    const diffBefore = diffRenders

    // Load an unrelated lazy grammar (`proto`); none of the mounted blocks or hooks may re-render.
    expect(highlightLines('syntax = "proto3";', 'proto')).toBeUndefined()
    await waitFor(() => { expect(loadedGrammarCount(['proto'])).toBe(1) }, { timeout: 5_000 })

    expect(tsCodeRenders).toBe(tsCodeBefore)
    expect(tomlCodeRenders).toBe(tomlCodeBefore)
    expect(tsReadRenders).toBe(tsReadBefore)
    expect(diffRenders).toBe(diffBefore)
    expect(tsHook.result.current).toBe(initialTsFn)
    expect(nixHook.result.current).toBe(initialNixFn)

    // Triggering `nix` updates only the `nix` hook, leaving `ts` untouched.
    expect(nixHook.result.current('{ a = 1; }')).toBeUndefined()
    await waitFor(() => { expect(nixHook.result.current).not.toBe(initialNixFn) }, { timeout: 5_000 })
    expect(nixHook.result.current('{ a = 1; }')).not.toBeUndefined()
    expect(tsHook.result.current).toBe(initialTsFn)
  })

  it('keeps off-screen CodeBlock and ReadBlock unsubscribed until they intersect the viewport', async () => {
    StubIntersectionObserver.instances = []
    vi.stubGlobal('IntersectionObserver', StubIntersectionObserver)

    let codeRenders = 0
    let readRenders = 0
    const view = render(
      <>
        <Profiler id="offscreen-code" onRender={() => { codeRenders += 1 }}>
          <CodeBlock code="[section]\nkey = 1" lang="ini" {...markdownLabels.code} />
        </Profiler>
        <Profiler id="offscreen-read" onRender={() => { readRenders += 1 }}>
          <ReadBlock
            label="main.hcl"
            lang="hcl"
            lines={[{ number: 1, text: 'resource "a" "b" {}' }]}
            totalLines={1}
            labels={readBlockLabels}
          />
        </Profiler>
      </>,
    )

    const codeBefore = codeRenders
    const readBefore = readRenders
    const observer = StubIntersectionObserver.instances[0]!

    // Load both grammars externally while the blocks stay off-screen.
    expect(highlightLines('[section]', 'ini')).toBeUndefined()
    expect(highlightLines('resource "a" "b" {}', 'hcl')).toBeUndefined()
    await waitFor(() => { expect(loadedGrammarCount(['ini', 'hcl'])).toBe(2) }, { timeout: 10_000 })

    // Neither off-screen surface was subscribed, so neither re-rendered.
    expect(codeRenders).toBe(codeBefore)
    expect(readRenders).toBe(readBefore)

    const codeEl = view.container.querySelector('.md-code-block')!
    const readEl = view.container.querySelector('[data-read]')!
    act(() => {
      observer.intersect(codeEl, true)
      observer.intersect(readEl, true)
    })

    await waitFor(() => {
      expect(codeEl.querySelector('pre.shiki')).not.toBeNull()
      expect(readEl.querySelectorAll('[class^="_content_"] span[style]').length).toBeGreaterThan(1)
    })
  })
})
