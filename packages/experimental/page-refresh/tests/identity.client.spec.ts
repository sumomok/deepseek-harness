// @vitest-environment jsdom
/**
 * What identifies a build, and how one is read out of a served index: the
 * document URL the check requests, the boot graph markup the host's renderer
 * emits, the order-independent comparison, the reload guard's key, and every
 * answer that leaves the build unknown.
 */

import { describe, expect, it } from 'vitest'
import { renderIndexInjections } from '@deepseek-ai/dsh-host-webserver'
import {
  BOOT_MARKUP_PREFIX,
  bootEntriesOf,
  bootGraphIn,
  buildKey,
  documentUrlOf,
  readServedBuild,
  sameBuild,
  type BuildIdentity,
} from '../src/client/identity.ts'
import { DOCUMENT_URL, FakePage, ORIGIN, revisions, servedIndex, settle } from './fake-browser.client.ts'

/** A build with the given entries and shell. */
function build(entries: Record<string, string>, shell: readonly string[] = [`${ORIGIN}/assets/index-A.js`]): BuildIdentity {
  return { entries: new Map(Object.entries(entries)), shell }
}

describe('the document URL', () => {
  it('is the navigation entry\'s, without its fragment', () => {
    expect(documentUrlOf('https://console.example/console/?a=1#chat', 'https://console.example/elsewhere'))
      .toBe('https://console.example/console/?a=1')
  })

  it('falls back to the address the page had when the plugin started', () => {
    expect(documentUrlOf(undefined, 'https://console.example/console/#x')).toBe('https://console.example/console/')
  })
})

describe('the boot graph markup', () => {
  it('is exactly what the host\'s index renderer emits for the boot global, `<` escaped included', () => {
    const graph = { rev: 'r', entries: [{ id: '<a>', rev: '1' }], batches: [] }
    const html = renderIndexInjections('<html><head></head><body></body></html>', [
      { kind: 'global', name: '__DSH_BOOT__', value: graph },
    ])
    expect(html).toContain(BOOT_MARKUP_PREFIX)
    expect(bootGraphIn(html)).toEqual({ graph })
  })

  it('names the index that carries no boot graph', () => {
    expect(bootGraphIn('<html><head></head></html>')).toEqual({ reason: 'the index carries no boot graph' })
  })

  it('names the boot graph that is never closed', () => {
    expect(bootGraphIn(`${BOOT_MARKUP_PREFIX}{"entries":[]}`)).toEqual({ reason: 'the boot graph is not closed' })
  })

  it('names the boot graph that is not JSON', () => {
    expect(bootGraphIn(`${BOOT_MARKUP_PREFIX}undefined</script>`)).toEqual({ reason: 'the boot graph is not JSON' })
  })
})

describe('the boot graph\'s entries', () => {
  it('maps every plugin id to its revision', () => {
    expect(bootEntriesOf({ entries: [{ id: 'a', rev: '1', url: 'x' }, { id: 'b', rev: '2' }] }))
      .toEqual(new Map([['a', '1'], ['b', '2']]))
  })

  it.each([
    ['no object', null],
    ['a string', 'graph'],
    ['no entries', { rev: 'r' }],
    ['entries that are not a list', { entries: { a: '1' } }],
    ['an entry that is not an object', { entries: ['a'] }],
    ['an entry without an id', { entries: [{ rev: '1' }] }],
    ['an entry without a revision', { entries: [{ id: 'a' }] }],
    ['a numeric revision', { entries: [{ id: 'a', rev: 1 }] }],
    ['a numeric id', { entries: [{ id: 1, rev: '1' }] }],
    ['a repeated id', { entries: [{ id: 'a', rev: '1' }, { id: 'a', rev: '2' }] }],
  ])('reads nothing from %s', (_case, graph) => {
    expect(bootEntriesOf(graph)).toBeUndefined()
  })
})

describe('build comparison', () => {
  const booted = build({ a: '1', b: '2' })

  it('is the same build whatever order the graph listed the plugins in', () => {
    const reordered: BuildIdentity = { entries: new Map([['b', '2'], ['a', '1']]), shell: booted.shell }
    expect(sameBuild(booted, reordered)).toBe(true)
    expect(buildKey(reordered)).toBe(buildKey(booted))
  })

  it.each([
    ['a plugin added', build({ a: '1', b: '2', c: '3' })],
    ['a plugin removed', build({ a: '1' })],
    ['a plugin swapped for another', build({ a: '1', c: '2' })],
    ['a revision changed', build({ a: '1', b: '3' })],
    ['only the shell changed', build({ a: '1', b: '2' }, [`${ORIGIN}/assets/index-B.js`])],
    ['a shell script added', build({ a: '1', b: '2' }, [`${ORIGIN}/assets/index-A.js`, `${ORIGIN}/assets/x.js`])],
  ])('is a different build with %s', (_case, served) => {
    expect(sameBuild(booted, served)).toBe(false)
    expect(buildKey(served)).not.toBe(buildKey(booted))
  })
})

describe('reading the served build', () => {
  /** Answer the page's one request and return what the read concluded. */
  async function read(answer: { status?: number; contentType?: string | null; body?: string }) {
    const page = new FakePage()
    const reading = readServedBuild(page, DOCUMENT_URL, new AbortController().signal)
    await settle()
    expect(page.lastRequest().url).toBe(DOCUMENT_URL)
    page.lastRequest().answer(answer)
    return await reading
  }

  it('reads the entries and the shell scripts, resolved against the index\'s own base', async () => {
    const served = await read({ body: servedIndex([{ id: 'a', rev: '1' }], ['./assets/index-A.js', './assets/vendor.js']) })
    expect(served).toEqual({
      kind: 'known',
      identity: { entries: revisions({ a: '1' }), shell: [`${ORIGIN}/assets/index-A.js`, `${ORIGIN}/assets/vendor.js`] },
    })
  })

  it('accepts a media type in any case, with parameters', async () => {
    const served = await read({ contentType: 'Text/HTML ; charset=utf-8', body: servedIndex([{ id: 'a', rev: '1' }]) })
    expect(served.kind).toBe('known')
  })

  it.each([
    ['a refusal', { status: 401 }, 'the index answered 401'],
    ['a redirect, which a manual-redirect request sees as status 0', { status: 0 }, 'the index answered 0'],
    ['a server error', { status: 502 }, 'the index answered 502'],
    ['no content type', { contentType: null }, 'the index answered no content type'],
    ['another content type', { contentType: 'application/json' }, 'the index answered application/json'],
    ['a page without the boot graph', { body: '<html></html>' }, 'the index carries no boot graph'],
    ['a boot graph that is not JSON', { body: `${BOOT_MARKUP_PREFIX}{</script>` }, 'the boot graph is not JSON'],
    ['a boot graph without valid entries', { body: `${BOOT_MARKUP_PREFIX}{"entries":[{"id":1}]}</script>` }, 'the boot graph lists no valid entries'],
    // What a host still composing its plugins serves, or one whose deployment removed this row.
    ['a boot graph that does not list this plugin', { body: `${BOOT_MARKUP_PREFIX}{"entries":[{"id":"a","rev":"1"}]}</script>` }, 'the boot graph does not list this plugin'],
    ['an empty boot graph', { body: `${BOOT_MARKUP_PREFIX}{"entries":[]}</script>` }, 'the boot graph does not list this plugin'],
  ])('knows nothing from %s', async (_case, answer, reason) => {
    expect(await read({ body: servedIndex([{ id: 'a', rev: '1' }]), ...answer })).toEqual({ kind: 'unknown', reason })
  })
})
