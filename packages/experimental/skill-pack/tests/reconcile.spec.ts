/**
 * Whether a pack is offered, and what it is waiting on when it is not.
 *
 * Every case here is the pure judgement: no pack root, no services, only the
 * manifests, the parts a component plugin registered, and the platform
 * version.
 */

import { describe, expect, it } from 'vitest'
import { describeMissing, reconcilePacks, type PackObservation } from '../src/reconcile.ts'
import type { PackMissing, ProvidedPart } from '../src/types.ts'

const PLATFORM = '0.5.2'

const KIT: ProvidedPart = { id: 'toy.crud', plugin: '@deepseek-ai/dsh-experimental-component-kit', version: '0.4.0' }
const CHART: ProvidedPart = { id: 'toy.chart', plugin: '@deepseek-ai/dsh-experimental-component-kit', version: '0.4.0' }

function pack(skill: string, metadata: {
  platform?: string
  components?: Record<string, string>
  parts?: string[]
  views?: string[]
}, views: PackObservation['views'] = []): PackObservation {
  return {
    skill,
    manifest: {
      ok: true,
      manifest: {
        pack: { version: '1.0.0', ...metadata.platform !== undefined ? { platform: metadata.platform } : {} },
        requires: { components: metadata.components ?? {}, parts: metadata.parts ?? [] },
        views: metadata.views ?? [],
      },
    },
    views,
  }
}

describe('pack reconciliation', () => {
  it('offers a pack whose every requirement is met, in skill-name order', () => {
    const statuses = reconcilePacks(
      [
        pack('space-data-page', { parts: ['toy.crud'], components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.4.0' } }),
        pack('asset-page', { platform: '>=0.5.0' }),
      ],
      [KIT],
      PLATFORM,
    )
    expect(statuses.map(status => status.skill)).toEqual(['asset-page', 'space-data-page'])
    expect(statuses.every(status => status.state === 'active')).toBe(true)
    expect(statuses.map(status => status.version)).toEqual(['1.0.0', '1.0.0'])
    expect(statuses.flatMap(status => status.missing)).toEqual([])
  })

  it('withholds a pack whose parts nothing has registered, which is the state before any component plugin is mounted', () => {
    const [status] = reconcilePacks([pack('space-data-page', { parts: ['toy.crud'] })], [], PLATFORM)
    expect(status).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [{ kind: 'part-absent', part: 'toy.crud' }],
    })
  })

  it('separates a plugin nothing registers from one registered at the wrong version', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', {
        components: {
          '@deepseek-ai/dsh-experimental-component-kit': '>=9.0.0',
          '@sumomok/dsh-balance': '>=0.4.0',
        },
      })],
      [KIT, CHART],
      PLATFORM,
    )
    expect(status?.missing).toEqual([
      {
        kind: 'plugin-version',
        plugin: '@deepseek-ai/dsh-experimental-component-kit',
        range: '>=9.0.0',
        present: '0.4.0',
      },
      { kind: 'plugin-absent', plugin: '@sumomok/dsh-balance', range: '>=0.4.0' },
    ])
  })

  it('judges a prerelease by its release numbers, because every package here carries one', () => {
    const rc: ProvidedPart = { id: 'toy.crud', plugin: 'kit', version: '0.4.0-rc.1' }
    const [status] = reconcilePacks(
      [pack('space-data-page', { platform: '>=0.5.0', components: { kit: '>=0.3.0' } })],
      [rc],
      '0.6.0-rc.2',
    )
    expect(status?.state).toBe('active')
  })

  it('withholds a pack the platform is too old for, naming both versions', () => {
    const [status] = reconcilePacks([pack('space-data-page', { platform: '>=9.0.0' })], [], PLATFORM)
    expect(status?.missing).toEqual([{ kind: 'platform-version', range: '>=9.0.0', present: PLATFORM }])
  })

  it('reports an unreadable manifest as the pack\'s only reason, since nothing else about it is knowable', () => {
    const [status] = reconcilePacks(
      [{ skill: 'broken', manifest: { ok: false, field: 'metadata.pack', reason: 'is required' }, views: [] }],
      [KIT],
      PLATFORM,
    )
    expect(status).toEqual({
      skill: 'broken',
      state: 'inactive',
      missing: [{ kind: 'manifest-invalid', field: 'metadata.pack', reason: 'is required' }],
    })
    expect(status?.version).toBeUndefined()
  })

  it('withholds the whole pack when one declared view is unreadable, not just that view', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml', 'views/b.yml'] }, [
        { ok: true, path: 'views/a.yml', view: { id: 'a', title: 'A', spec: [], params: {} } },
        { ok: false, path: 'views/b.yml', reason: 'has no title' },
      ])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('inactive')
    expect(status?.missing).toEqual([{ kind: 'view-unreadable', view: 'views/b.yml', reason: 'has no title' }])
  })

  it('collects every reason at once, in the fixed order platform, plugins, parts, views', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', {
        platform: '>=9.0.0',
        components: { kit: '>=1.0.0' },
        parts: ['toy.crud'],
        views: ['views/b.yml'],
      }, [{ ok: false, path: 'views/b.yml', reason: 'is not a YAML mapping' }])],
      [],
      PLATFORM,
    )
    expect(status?.missing.map(missing => missing.kind))
      .toEqual(['platform-version', 'plugin-absent', 'part-absent', 'view-unreadable'])
  })
})

/** One view file that parsed, as the pack root hands it to reconciliation. */
function view(path: string, id: string): PackObservation['views'][number] {
  return { ok: true, path, view: { id, title: id, spec: { nodes: [] }, params: {} } }
}

describe('the views a pack declares, judged by the surface that would draw them', () => {
  it('withholds a pack whose view the surface refuses, naming the file, the value and the reason', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
      () => ({ path: 'spec.nodes[0].component', reason: 'names no component of this deployment' }),
    )
    expect(status?.state).toBe('inactive')
    expect(status?.missing).toEqual([{
      kind: 'view-refused',
      view: 'views/a.yml',
      path: 'spec.nodes[0].component',
      reason: 'names no component of this deployment',
    }])
  })

  it('names every refused view of one pack, so a pack with two wrong ones is corrected once', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml', 'views/b.yml'] }, [view('views/a.yml', 'layers'), view('views/b.yml', 'sites')])],
      [],
      PLATFORM,
      () => ({ path: 'spec', reason: 'is refused' }),
    )
    expect(status?.missing.map(missing => missing.kind)).toEqual(['view-refused', 'view-refused'])
  })

  it('judges only the views that parsed, and reports the unreadable one on its own', () => {
    const judged: string[] = []
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml', 'views/b.yml'] }, [
        { ok: false, path: 'views/a.yml', reason: 'has no title' },
        view('views/b.yml', 'sites'),
      ])],
      [],
      PLATFORM,
      (one) => {
        judged.push(one.id)
        return undefined
      },
    )
    expect(judged).toEqual(['sites'])
    expect(status?.missing).toEqual([{ kind: 'view-unreadable', view: 'views/a.yml', reason: 'has no title' }])
  })

  it('hands each pack the view ids the packs before it claimed, and only the offered ones claim any', () => {
    const claims: string[][] = []
    const statuses = reconcilePacks(
      [
        pack('a-pack', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')]),
        pack('b-pack', { parts: ['toy.crud'], views: ['views/b.yml'] }, [view('views/b.yml', 'sites')]),
        pack('c-pack', { views: ['views/c.yml'] }, [view('views/c.yml', 'alerts')]),
      ],
      [],
      PLATFORM,
      (_one, claimed) => {
        claims.push([...claimed])
        return undefined
      },
    )
    // `b-pack` is withheld for its missing part, so the id its view would have
    // claimed is not held away from anyone.
    expect(statuses.map(status => status.state)).toEqual(['active', 'inactive', 'active'])
    expect(claims).toEqual([[], ['layers'], ['layers']])
  })

  it('carries a view through unjudged where no component surface is composed', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('active')
  })
})

describe('missing-requirement sentences', () => {
  it('states each refused value', () => {
    const cases: [PackMissing, string][] = [
      [{ kind: 'manifest-invalid', field: 'metadata.pack', reason: 'is required' }, 'metadata.pack is required'],
      [{ kind: 'platform-version', range: '>=9.0.0', present: '0.5.2' }, 'platform 0.5.2 is outside >=9.0.0'],
      [{ kind: 'plugin-absent', plugin: 'kit', range: '>=1.0.0' }, 'kit >=1.0.0 is not installed'],
      [
        { kind: 'plugin-version', plugin: 'kit', range: '>=1.0.0', present: '0.4.0' },
        'kit is installed at 0.4.0, outside >=1.0.0',
      ],
      [{ kind: 'part-absent', part: 'toy.crud' }, 'no component plugin registers the part toy.crud'],
      [
        { kind: 'view-unreadable', view: 'views/b.yml', reason: 'has no title' },
        'view views/b.yml is unreadable: has no title',
      ],
      [
        { kind: 'view-refused', view: 'views/b.yml', path: 'spec.nodes[0].component', reason: 'names no component of this deployment' },
        'view views/b.yml cannot be drawn: names no component of this deployment',
      ],
    ]
    expect(cases.map(([missing]) => describeMissing(missing))).toEqual(cases.map(([, sentence]) => sentence))
  })
})
