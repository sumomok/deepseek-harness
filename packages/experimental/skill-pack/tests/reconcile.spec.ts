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

const KIT: ProvidedPart = { id: 'toy.data-page', plugin: '@deepseek-ai/dsh-experimental-component-kit', version: '0.4.0' }
const CHART: ProvidedPart = { id: 'toy.chart', plugin: '@deepseek-ai/dsh-experimental-component-kit', version: '0.4.0' }

function pack(skill: string, metadata: {
  platform?: string
  components?: Record<string, string>
  parts?: string[]
  views?: string[]
  viewFormat?: number | null
  anchorFormat?: number
} = {}, views: PackObservation['views'] = []): PackObservation {
  // `null` is a pack that declares views and states no format at all; a number
  // is the format it states; absence is the format a pack declaring views has
  // to state, which is the one this build reads.
  const viewFormat = metadata.viewFormat === undefined ? 1 : metadata.viewFormat
  return {
    skill,
    manifest: {
      ok: true,
      manifest: {
        pack: {
          version: '1.0.0',
          ...metadata.platform !== undefined ? { platform: metadata.platform } : {},
          ...viewFormat === null ? {} : { viewFormat },
          ...metadata.anchorFormat === undefined ? {} : { anchorFormat: metadata.anchorFormat },
        },
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
        pack('space-data-page', { parts: ['toy.data-page'], components: { '@deepseek-ai/dsh-experimental-component-kit': '>=0.4.0' } }),
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
    const [status] = reconcilePacks([pack('space-data-page', { parts: ['toy.data-page'] })], [], PLATFORM)
    expect(status).toEqual({
      skill: 'space-data-page',
      version: '1.0.0',
      state: 'inactive',
      missing: [{ kind: 'part-absent', part: 'toy.data-page' }],
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
    const rc: ProvidedPart = { id: 'toy.data-page', plugin: 'kit', version: '0.4.0-rc.1' }
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
        parts: ['toy.data-page'],
        views: ['views/b.yml'],
      }, [{ ok: false, path: 'views/b.yml', reason: 'is not a YAML mapping' }])],
      [],
      PLATFORM,
    )
    expect(status?.missing.map(missing => missing.kind))
      .toEqual(['platform-version', 'plugin-absent', 'part-absent', 'view-unreadable'])
  })

  it('puts packs in code-unit order, so two hosts holding the same root answer the same list', () => {
    const statuses = reconcilePacks(
      [pack('图层'), pack('asset-page'), pack('Asset-page'), pack('asset-page'), pack('资产')],
      [],
      PLATFORM,
    )
    expect(statuses.map(status => status.skill)).toEqual(['Asset-page', 'asset-page', 'asset-page', '图层', '资产'])
  })
})

describe('the anchor format a pack states', () => {
  it('offers a pack stating an anchor format this build reads', () => {
    const [status] = reconcilePacks([pack('space-data-page', { anchorFormat: 1 })], [], PLATFORM)
    expect(status?.state).toBe('active')
  })

  it('withholds the whole pack when this build does not read its anchor format, before naming its view format', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { parts: ['toy.data-page'], anchorFormat: 2, views: ['views/a.yml'], viewFormat: 7 }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('inactive')
    expect(status?.missing).toEqual([
      { kind: 'part-absent', part: 'toy.data-page' },
      { kind: 'anchor-format', stated: 2, reads: [1] },
      { kind: 'view-format', stated: 7, reads: [1] },
    ])
  })
})

describe('the view-file format a pack declares its views in', () => {
  it('offers a pack whose views are written in a format this build reads', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'], viewFormat: 1 }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('active')
  })

  it('withholds a pack whose views are written in a format this build does not read, naming both', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'], viewFormat: 7 }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('inactive')
    expect(status?.missing).toEqual([{ kind: 'view-format', stated: 7, reads: [1] }])
  })

  it('withholds a pack that declares views and states no format, because the files say nothing about themselves', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'], viewFormat: null }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.missing).toEqual([{ kind: 'view-format', reads: [1] }])
  })

  it('reports the unreadable format instead of what each file parsed into, and claims no view id', () => {
    const judged: string[] = []
    const statuses = reconcilePacks(
      [
        pack('a-pack', { views: ['views/a.yml', 'views/b.yml'], viewFormat: 7 }, [
          view('views/a.yml', 'layers'),
          { ok: false, path: 'views/b.yml', reason: 'has no title' },
        ]),
        pack('b-pack', { views: ['views/c.yml'] }, [view('views/c.yml', 'layers')]),
      ],
      [],
      PLATFORM,
      (one) => {
        judged.push(one.id)
        return undefined
      },
    )
    expect(judged).toEqual(['layers'])
    expect(statuses.map(status => status.missing.map(missing => missing.kind))).toEqual([['view-format'], []])
  })

  it('says nothing about the format of a pack that declares no views, whatever it states', () => {
    const statuses = reconcilePacks(
      [pack('plain-note', { viewFormat: null }), pack('other-note', { viewFormat: 7 })],
      [],
      PLATFORM,
    )
    expect(statuses.every(status => status.state === 'active')).toBe(true)
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

  it('carries a view through unjudged where no component surface is composed', () => {
    const [status] = reconcilePacks(
      [pack('space-data-page', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')])],
      [],
      PLATFORM,
    )
    expect(status?.state).toBe('active')
  })
})

describe('one view id claimed by two packs', () => {
  it('withholds both of them, each naming the id and the other pack', () => {
    const statuses = reconcilePacks(
      [
        pack('a-pack', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')]),
        pack('b-pack', { views: ['views/b.yml'] }, [view('views/b.yml', 'layers')]),
      ],
      [],
      PLATFORM,
    )
    expect(statuses).toEqual([
      {
        skill: 'a-pack',
        version: '1.0.0',
        state: 'inactive',
        missing: [{ kind: 'view-id-conflict', id: 'layers', pack: 'b-pack' }],
      },
      {
        skill: 'b-pack',
        version: '1.0.0',
        state: 'inactive',
        missing: [{ kind: 'view-id-conflict', id: 'layers', pack: 'a-pack' }],
      },
    ])
  })

  it('answers the same whichever order the packs arrive in, and whatever their names sort like', () => {
    const contenders = [
      pack('Zulu', { views: ['views/a.yml'] }, [view('views/a.yml', 'layers')]),
      pack('图层包', { views: ['views/b.yml'] }, [view('views/b.yml', 'layers')]),
      pack('alpha', { views: ['views/c.yml'] }, [view('views/c.yml', 'alerts')]),
    ]
    const forwards = reconcilePacks(contenders, [], PLATFORM)
    const backwards = reconcilePacks([...contenders].reverse(), [], PLATFORM)
    expect(forwards).toEqual(backwards)
    expect(forwards.map(status => [status.skill, status.state]))
      .toEqual([['Zulu', 'inactive'], ['alpha', 'active'], ['图层包', 'inactive']])
  })

  it('names every pack that contests an id, and every id one pack contests', () => {
    const statuses = reconcilePacks(
      [
        pack('a-pack', { views: ['views/a.yml', 'views/b.yml'] }, [view('views/a.yml', 'layers'), view('views/b.yml', 'sites')]),
        pack('b-pack', { views: ['views/c.yml'] }, [view('views/c.yml', 'layers')]),
        pack('c-pack', { views: ['views/d.yml'] }, [view('views/d.yml', 'sites')]),
        pack('d-pack', { views: ['views/e.yml'] }, [view('views/e.yml', 'layers')]),
      ],
      [],
      PLATFORM,
    )
    expect(statuses[0]?.missing).toEqual([
      { kind: 'view-id-conflict', id: 'layers', pack: 'b-pack' },
      { kind: 'view-id-conflict', id: 'layers', pack: 'd-pack' },
      { kind: 'view-id-conflict', id: 'sites', pack: 'c-pack' },
    ])
    expect(statuses.map(status => status.state)).toEqual(['inactive', 'inactive', 'inactive', 'inactive'])
  })

  it('leaves a pack that was withheld for another reason holding no id, so nobody loses one to it', () => {
    const statuses = reconcilePacks(
      [
        pack('a-pack', { parts: ['toy.data-page'], views: ['views/a.yml'] }, [view('views/a.yml', 'layers')]),
        pack('b-pack', { views: ['views/b.yml'] }, [view('views/b.yml', 'layers')]),
      ],
      [],
      PLATFORM,
    )
    expect(statuses.map(status => [status.skill, status.state]))
      .toEqual([['a-pack', 'inactive'], ['b-pack', 'active']])
    expect(statuses[0]?.missing).toEqual([{ kind: 'part-absent', part: 'toy.data-page' }])
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
      [{ kind: 'part-absent', part: 'toy.data-page' }, 'no component plugin registers the part toy.data-page'],
      [{ kind: 'view-format', stated: 7, reads: [1, 2] }, 'declares views in view format 7; this build reads 1, 2'],
      [{ kind: 'anchor-format', stated: 2, reads: [1] }, 'states anchor format 2; this build reads 1'],
      [
        { kind: 'view-format', reads: [1] },
        'declares views without metadata.pack.viewFormat; this build reads 1',
      ],
      [
        { kind: 'view-unreadable', view: 'views/b.yml', reason: 'has no title' },
        'view views/b.yml is unreadable: has no title',
      ],
      [
        { kind: 'view-refused', view: 'views/b.yml', path: 'spec.nodes[0].component', reason: 'names no component of this deployment' },
        'view views/b.yml cannot be drawn: names no component of this deployment',
      ],
      [
        { kind: 'view-id-conflict', id: 'layers', pack: 'other-pack' },
        'the view id layers is declared by other-pack as well',
      ],
    ]
    expect(cases.map(([missing]) => describeMissing(missing))).toEqual(cases.map(([, sentence]) => sentence))
  })
})
