/**
 * What one backend answer reduces to: which subject areas exist, which models
 * are filed under one of them, what the schemes say about an attribute, and
 * where a listing stops.
 *
 * Every case here is a pure function of a stated answer, which is what lets the
 * order and the cut be asserted exactly rather than described.
 */

import { describe, expect, it } from 'vitest'
import type {
  BizMetaAttribute,
  BizModelSummary,
  BizOperation,
  BizPermissions,
  BizScheme,
} from '@deepseek-ai/dsh-experimental-biz-backend'
import {
  attributeEntries,
  compareNames,
  domainOf,
  editableColumns,
  groupDomains,
  modelEntries,
  noteOf,
  pageWithin,
  permittedOperations,
  resolveDomain,
  resolveModel,
  rightsByModel,
  UNFILED,
  visibleModels,
} from '../src/reduce.ts'
import type { MapBounds } from '../src/types.ts'

/** The ceilings most cases here read under; a case bounding something states its own. */
const BOUNDS: MapBounds = { listingChars: 12000, valuesPerAttribute: 12, noteChars: 80 }

/**
 * Permissions granting exactly the stated operations.
 * @param granted - model name to the operations it is granted.
 * @returns the permissions.
 */
function permissionsOf(granted: Readonly<Record<string, readonly BizOperation[]>>): BizPermissions {
  return { may: (model, operation) => granted[model]?.includes(operation) ?? false }
}

/**
 * One catalog entry.
 * @param model - the English name.
 * @param rest - whatever else the catalog states about it.
 * @returns the entry.
 */
function summary(model: string, rest: Partial<BizModelSummary> = {}): BizModelSummary {
  return { resClassEnName: model, resClassCnName: '', ...rest }
}

/** Three models across two subject areas, one of them filed under none. */
const CATALOG: readonly BizModelSummary[] = [
  summary('SpaceLayer', { resClassCnName: '空间图层', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业', dsTableName: 'SPACE_LAYER' }),
  summary('CITY', { resClassCnName: '地市', classDiagramType: 'COMMON', classDiagramTypeCnName: '公共专业' }),
  summary('SITE', { resClassCnName: '站点', classDiagramType: 'TRANSO', classDiagramTypeCnName: '传输专业' }),
  summary('Orphan', { resClassCnName: '未归档' }),
]

describe('comparing names', () => {
  it('orders by code unit in both directions and calls equal names equal', () => {
    expect(compareNames('A', 'B')).toBe(-1)
    expect(compareNames('B', 'A')).toBe(1)
    expect(compareNames('A', 'A')).toBe(0)
    // Code unit, not locale: an uppercase letter sorts before every lowercase
    // one, which a locale comparison would interleave.
    expect(['b', 'A', 'a', 'B'].sort(compareNames)).toEqual(['A', 'B', 'a', 'b'])
  })
})

describe('the subject area a model is filed under', () => {
  it('takes the code and the name the catalog states', () => {
    expect(domainOf(CATALOG[0] as BizModelSummary)).toEqual({ domain: 'TRANSO', name: '传输专业' })
  })

  it('stands a fixed word in for a model filed under nothing, and the code in for a missing name', () => {
    expect(domainOf(summary('Orphan'))).toEqual({ domain: UNFILED, name: UNFILED })
    expect(domainOf(summary('SITE', { classDiagramType: 'TRANSO' }))).toEqual({ domain: 'TRANSO', name: 'TRANSO' })
  })
})

describe('grouping a catalog into subject areas', () => {
  it('counts the models of each and lists them in code order', () => {
    expect(groupDomains(CATALOG)).toEqual([
      { domain: 'COMMON', name: '公共专业', models: 1 },
      { domain: 'TRANSO', name: '传输专业', models: 2 },
      { domain: UNFILED, name: UNFILED, models: 1 },
    ])
  })

  it('settles a disagreement about one code\'s name on the model that sorts first', () => {
    expect(groupDomains([
      summary('Zeta', { classDiagramType: 'TRANSO', classDiagramTypeCnName: '后写的名字' }),
      summary('Alpha', { classDiagramType: 'TRANSO', classDiagramTypeCnName: '先写的名字' }),
    ])).toEqual([{ domain: 'TRANSO', name: '先写的名字', models: 2 }])
  })

  it('groups an empty catalog into no subject areas', () => {
    expect(groupDomains([])).toEqual([])
  })
})

describe('resolving what a request named', () => {
  it('finds a subject area by its code first and by its name second', () => {
    const domains = groupDomains(CATALOG)
    expect(resolveDomain(domains, 'TRANSO')?.domain).toBe('TRANSO')
    expect(resolveDomain(domains, '公共专业')?.domain).toBe('COMMON')
    expect(resolveDomain(domains, 'nothing')).toBeUndefined()
  })

  it('finds a model by its English name first and by its shown name second', () => {
    expect(resolveModel(CATALOG, 'SITE')?.resClassEnName).toBe('SITE')
    expect(resolveModel(CATALOG, '空间图层')?.resClassEnName).toBe('SpaceLayer')
    expect(resolveModel(CATALOG, 'nothing')).toBeUndefined()
  })

  it('resolves two models sharing one shown name to the one that sorts first', () => {
    const shared = [summary('Zeta', { resClassCnName: '同名' }), summary('Alpha', { resClassCnName: '同名' })]
    expect(resolveModel(shared, '同名')?.resClassEnName).toBe('Alpha')
  })
})

describe('what a deployment records about a model', () => {
  it('prefers the short note, falls back to the long description, and cuts to the ceiling', () => {
    expect(noteOf(summary('A', { remark: '短', resClassDescription: '长' }), 80)).toBe('短')
    expect(noteOf(summary('A', { resClassDescription: '长' }), 80)).toBe('长')
    expect(noteOf(summary('A'), 80)).toBeUndefined()
    expect(noteOf(summary('A', { remark: 'abcdef' }), 4)).toBe('abcd')
    // Exactly at the ceiling is not cut.
    expect(noteOf(summary('A', { remark: 'abcd' }), 4)).toBe('abcd')
  })
})

describe('the rights table', () => {
  it('reads one row per model and the attributes editing is narrowed to', () => {
    const rights = rightsByModel({
      resclass: [{ resclassenname: 'SpaceLayer', operations: ['add', 'search'], columns: ' zh_label , layer_id ,, ' }],
      rows: [],
    })
    expect(rights.get('SpaceLayer')?.operations).toEqual(['add', 'search'])
    expect(editableColumns(rights.get('SpaceLayer'))).toEqual(['zh_label', 'layer_id'])
    expect(editableColumns(rights.get('SITE'))).toBeUndefined()
    expect(editableColumns({ resclassenname: 'SITE', operations: [], columns: ' , ' })).toBeUndefined()
  })
})

describe('what the signed-in person may look at', () => {
  it('keeps only the models whose description this person may read, in catalog order', () => {
    const permissions = permissionsOf({ SITE: ['metadata_read'], SpaceLayer: ['read'] })
    expect(visibleModels([summary('SpaceLayer'), summary('SITE'), summary('CITY')], permissions))
      .toEqual([summary('SITE')])
  })

  it('lists the permitted operations in the order the backend lists its operation codes', () => {
    const permissions = permissionsOf({ SITE: ['export', 'read', 'create'] })
    expect(permittedOperations(permissions, 'SITE')).toEqual(['read', 'create', 'export'])
    expect(permittedOperations(permissions, 'CITY')).toEqual([])
  })
})

describe('one subject area\'s models', () => {
  it('lists them in English-name order with the fields this deployment states', () => {
    const permissions = permissionsOf({ SITE: ['read', 'metadata_read'], SpaceLayer: ['metadata_read'] })
    expect(modelEntries(
      [CATALOG[0] as BizModelSummary, CATALOG[2] as BizModelSummary],
      permissions,
      80,
    )).toEqual([
      { model: 'SITE', name: '站点', may: ['read', 'metadata_read'] },
      { model: 'SpaceLayer', name: '空间图层', table: 'SPACE_LAYER', may: ['metadata_read'] },
    ])
  })

  it('leaves the shown name out of a model the catalog names in one language only', () => {
    expect(modelEntries([summary('SITE', { remark: '说明' })], permissionsOf({ SITE: ['metadata_read'] }), 80))
      .toEqual([{ model: 'SITE', may: ['metadata_read'], note: '说明' }])
  })
})

/**
 * One attribute as the model describes it.
 * @param attribute - the English name.
 * @param rest - whatever else the description states.
 * @returns the attribute.
 */
function attribute(attribute_: string, rest: Partial<BizMetaAttribute> = {}): BizMetaAttribute {
  return { attributeEnName: attribute_, attributeCnName: '', ...rest }
}

describe('what the schemes say about an attribute', () => {
  /** Four schemes drawing one attribute in different ways. */
  const SCHEMES: readonly BizScheme[] = [
    {
      schemaType: 1,
      formItems: [{ relatedMetaAttr: 'state' }, { relatedMetaAttr: 'hidden', isShow: false }],
      columns: [{ relatedMetaAttr: 'state', isShow: true }, { relatedMetaAttr: 'hidden', isShow: false }],
    },
    {
      schemaType: 2,
      formItems: [
        { relatedMetaAttr: 'state', isRequired: true, isEditable: true, relatedDict: [{ key: '1', value: '在用' }, { key: '0', value: '停用' }] },
        { relatedMetaAttr: 'city_id', relatedMeta: 'CITY' },
      ],
      columns: [],
    },
    {
      schemaType: 3,
      formItems: [{ relatedMetaAttr: 'state', isEditable: false }, { relatedMetaAttr: 'state' }],
      columns: [],
    },
    { schemaType: 9, formItems: [{ relatedMetaAttr: 'state', relatedMeta: 'NEVER' }], columns: [] },
  ]

  it('names the forms in the order a person meets them, and takes the values from the first form stating them', () => {
    const [cityId, hidden, state] = attributeEntries(
      [attribute('state'), attribute('city_id'), attribute('hidden')],
      SCHEMES,
      BOUNDS,
    )
    expect(state).toEqual({
      attribute: 'state',
      required: true,
      editable: false,
      forms: ['query', 'grid', 'add', 'modify'],
      values: [{ stored: '1', shown: '在用' }, { stored: '0', shown: '停用' }],
    })
    expect(cityId).toEqual({ attribute: 'city_id', forms: ['add'], picks: 'CITY' })
    // Drawn by no form it is shown in, so only the table it is listed in — and
    // that listing is hidden too, so it is in neither.
    expect(hidden).toEqual({ attribute: 'hidden' })
  })

  it('names the table once however many schemes list the attribute in theirs', () => {
    const listedTwice: readonly BizScheme[] = [
      { schemaType: 1, formItems: [], columns: [{ relatedMetaAttr: 'zh_label', isShow: true }] },
      { schemaType: 4, formItems: [], columns: [{ relatedMetaAttr: 'zh_label' }] },
    ]
    expect(attributeEntries([attribute('zh_label')], listedTwice, BOUNDS))
      .toEqual([{ attribute: 'zh_label', forms: ['grid'] }])
  })

  it('reads an attribute no scheme mentions as one this deployment states nothing about', () => {
    expect(attributeEntries([attribute('lonely')], SCHEMES, BOUNDS)).toEqual([{ attribute: 'lonely' }])
  })

  it('takes editable from the first form stating it when no form refuses the change', () => {
    const [entry] = attributeEntries([attribute('state')], [
      { schemaType: 2, formItems: [{ relatedMetaAttr: 'state', isEditable: true }], columns: [] },
    ], BOUNDS)
    expect(entry).toEqual({ attribute: 'state', editable: true, forms: ['add'] })
  })

  it('publishes everything the model describes beside what the schemes say', () => {
    expect(attributeEntries([attribute('zh_label', {
      attributeCnName: '名称',
      dataType: 'VARCHAR',
      dataLength: 128,
      isPrimaryKey: true,
      isNull: false,
      defaultValue: '未命名',
      attrGrpName: '基本信息',
    })], [], BOUNDS)).toEqual([{
      attribute: 'zh_label',
      name: '名称',
      type: 'VARCHAR',
      length: 128,
      key: true,
      nullable: false,
      default: '未命名',
      group: '基本信息',
    }])
  })

  it('counts the fixed values the ceiling leaves out rather than carrying them', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({ key: String(index), value: `取值${String(index)}` }))
    const [entry] = attributeEntries([attribute('state')], [
      { schemaType: 2, formItems: [{ relatedMetaAttr: 'state', relatedDict: many }], columns: [] },
    ], { ...BOUNDS, valuesPerAttribute: 2 })
    expect(entry?.values).toEqual([{ stored: '0', shown: '取值0' }, { stored: '1', shown: '取值1' }])
    expect(entry?.moreValues).toBe(3)
  })

  it('orders the attributes by English name whatever order the description lists them in', () => {
    expect(attributeEntries([attribute('zeta'), attribute('alpha')], [], BOUNDS).map(entry => entry.attribute))
      .toEqual(['alpha', 'zeta'])
  })
})

describe('taking as much of a listing as the budget allows', () => {
  /** Five entries whose rendered line is exactly four characters long. */
  const ENTRIES = ['a', 'b', 'c', 'd', 'e'].map(key => ({ key }))

  /**
   * Page the fixture entries.
   * @param after - the cursor to continue from.
   * @param budget - characters the lines may spend.
   * @returns the page.
   */
  function page(after: string | undefined, budget: number) {
    return pageWithin(ENTRIES, after, entry => entry.key, entry => `${entry.key}xxx`, budget)
  }

  it('takes the whole listing when the budget covers it', () => {
    expect(page(undefined, 100)).toEqual({ items: ENTRIES, to: 5, truncated: false })
  })

  it('cuts at the last entry that fits and hands back its key', () => {
    // Two lines of four characters plus one newline each is exactly ten.
    expect(page(undefined, 10)).toEqual({ items: ENTRIES.slice(0, 2), to: 2, truncated: true, cursor: 'b' })
  })

  it('continues strictly past the cursor it is given', () => {
    expect(page('b', 100)).toEqual({ items: ENTRIES.slice(2), to: 5, truncated: false })
  })

  it('answers a cursor past the end with an empty listing rather than starting over', () => {
    expect(page('z', 100)).toEqual({ items: [], to: 5, truncated: false })
  })

  it('carries one entry longer than the whole budget alone rather than handing back the cursor it was given', () => {
    // Without this a caller following the cursor would never move: the answer
    // would take nothing and return the key it was already past.
    expect(page(undefined, 1)).toEqual({ items: ENTRIES.slice(0, 1), to: 1, truncated: true, cursor: 'a' })
    expect(page('a', 1)).toEqual({ items: ENTRIES.slice(1, 2), to: 2, truncated: true, cursor: 'b' })
  })
})
