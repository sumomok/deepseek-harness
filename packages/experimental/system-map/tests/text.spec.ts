/**
 * Every sentence a model reads: what the three descriptions promise, what each
 * refusal says and does not say, and what one listing renders as.
 *
 * Two rules are checked over the whole set rather than case by case, because
 * both are rules about what is absent: no description names another tool, and
 * no refusal names a tool to recover with.
 */

import { describe, expect, it } from 'vitest'
import {
  AFTER_ATTRIBUTES_PARAMETER_DESCRIPTION,
  AFTER_PARAMETER_DESCRIPTION,
  attributeLine,
  cutLine,
  DOMAIN_MODELS_DESCRIPTION,
  DOMAIN_MODELS_TOOL_NAME,
  DOMAIN_PARAMETER_DESCRIPTION,
  DOMAINS_DESCRIPTION,
  DOMAINS_TOOL_NAME,
  domainLine,
  domainsHeading,
  emptyRefusal,
  MODEL_DESCRIPTION,
  MODEL_PARAMETER_DESCRIPTION,
  MODEL_TOOL_NAME,
  modelHeading,
  modelLine,
  modelsHeading,
  refusedRefusal,
  rejectedRefusal,
  renderDomainModels,
  renderDomains,
  renderModel,
  UNAUTHENTICATED_REFUSAL,
  unknownDomainRefusal,
  unknownModelRefusal,
  unreachableRefusal,
} from '../src/text.ts'
import type { DomainEntry, DomainModelsValue, DomainsValue, ModelValue } from '../src/types.ts'

/** The three names this package puts on the wire. */
const TOOL_NAMES = [DOMAINS_TOOL_NAME, DOMAIN_MODELS_TOOL_NAME, MODEL_TOOL_NAME]

describe('the three descriptions', () => {
  it('name no other tool', () => {
    const descriptions = [DOMAINS_DESCRIPTION, DOMAIN_MODELS_DESCRIPTION, MODEL_DESCRIPTION]
    for (const description of descriptions) {
      for (const name of TOOL_NAMES) expect(description).not.toContain(name)
    }
  })

  it('say what their own tool answers with rather than how it is fetched', () => {
    for (const description of [DOMAINS_DESCRIPTION, DOMAIN_MODELS_DESCRIPTION, MODEL_DESCRIPTION]) {
      expect(description).toContain('this deployment')
      // Transport vocabulary would put the model in the wrong problem: none of
      // the three issues a request a model has anything to say about. A screen
      // is named on purpose, in both directions — a person says which screen
      // they work in, and the answer is never about one.
      for (const word of ['HTTP', 'endpoint', 'API', 'JSON', 'request body', 'query string']) {
        expect(description).not.toContain(word)
      }
      expect(description).toContain('never what is on screen')
    }
    expect(DOMAINS_DESCRIPTION).toContain('subject areas')
    expect(DOMAIN_MODELS_DESCRIPTION).toContain('which operations the signed-in person may perform')
    expect(MODEL_DESCRIPTION).toContain('every attribute')
  })

  it('describe each of the parameters their own tool takes', () => {
    expect(DOMAIN_PARAMETER_DESCRIPTION).toContain('subject area')
    expect(MODEL_PARAMETER_DESCRIPTION).toContain('data model')
    expect(AFTER_PARAMETER_DESCRIPTION).toContain('cursor')
    expect(AFTER_ATTRIBUTES_PARAMETER_DESCRIPTION).toContain('attribute')
  })
})

describe('the refusals', () => {
  /** One of each refusal, with the values that make them differ. */
  const REFUSALS = [
    emptyRefusal('domain'),
    UNAUTHENTICATED_REFUSAL,
    refusedRefusal(401),
    rejectedRefusal(200, 4, '没有权限'),
    rejectedRefusal(500, undefined, undefined),
    unreachableRefusal('the answer listed no resource models'),
    unknownDomainRefusal('TRANSMISSION', [{ domain: 'TRANSO', name: '传输专业', models: 2 }]),
    unknownModelRefusal('空间图层表'),
  ]

  it('name no tool to recover with', () => {
    for (const refusal of REFUSALS) {
      for (const name of TOOL_NAMES) expect(refusal).not.toContain(name)
    }
  })

  it('state why the call was refused', () => {
    expect(UNAUTHENTICATED_REFUSAL).toBe(
      'Nobody is signed in to this deployment, so nothing about its business system could be read.')
    expect(refusedRefusal(403)).toContain('refused the signed-in person\'s credential (HTTP 403)')
    expect(rejectedRefusal(200, 4, '没有权限')).toBe('This deployment refused the request (HTTP 200, code 4): 没有权限.')
    expect(rejectedRefusal(500, undefined, undefined)).toBe('This deployment refused the request (HTTP 500).')
    expect(unreachableRefusal('the answer listed no resource models'))
      .toBe('This deployment\'s business system did not answer: the answer listed no resource models.')
  })

  it('name the parameter that would fix the call', () => {
    expect(emptyRefusal('domain')).toContain('`domain` was empty')
    expect(unknownDomainRefusal('X', [])).toContain('Pass `domain`')
    expect(unknownModelRefusal('X')).toContain('Pass `model`')
  })

  it('lists the subject areas this deployment has, and counts the ones past the bound', () => {
    const many: DomainEntry[] = Array.from({ length: 30 }, (_, index) => ({
      domain: `D${String(index).padStart(2, '0')}`,
      name: `第${String(index)}号专业`,
      models: 1,
    }))
    const refusal = unknownDomainRefusal('TRANSMISSION', many)
    expect(refusal).toContain('D00 (第0号专业)')
    expect(refusal).toContain('D23 (第23号专业)')
    expect(refusal).not.toContain('D24 (')
    expect(refusal).toContain('and 6 more.')
  })

  it('cuts a value it repeats back rather than echoing whatever the model wrote', () => {
    const long = 'x'.repeat(500)
    expect(unknownModelRefusal(long)).toContain(`"${'x'.repeat(80)}"`)
    expect(unknownModelRefusal(long)).not.toContain('x'.repeat(81))
    expect(unknownDomainRefusal(long, [])).not.toContain('x'.repeat(81))
  })
})

describe('the rendered listings', () => {
  it('renders a subject-area listing under a heading naming every key it uses', () => {
    const value: DomainsValue = {
      domains: [{ domain: 'TRANSO', name: '传输专业', models: 2 }],
      from: 0,
      shown: 1,
      total: 1,
      truncated: false,
    }
    expect(renderDomains(value)).toBe(`${domainsHeading(1)}\nTRANSO name=传输专业 models=2`)
    expect(domainLine({ domain: 'TRANSO', name: '传输专业', models: 2 })).toBe('TRANSO name=传输专业 models=2')
  })

  it('ends a cut listing with the position it reached and the cursor to continue from', () => {
    const value: DomainsValue = {
      domains: [{ domain: 'TRANSO', name: '传输专业', models: 2 }],
      from: 4,
      shown: 1,
      total: 9,
      truncated: true,
      cursor: 'TRANSO',
    }
    expect(renderDomains(value).split('\n').at(-1)).toBe(cutLine(5, 9, 'TRANSO'))
    expect(cutLine(5, 9, 'TRANSO')).toBe('Cut after 5 of 9; pass "TRANSO" as `after` to continue.')
  })

  it('leaves out every field of a model line this deployment states nothing for', () => {
    expect(modelLine({ model: 'SITE' })).toBe('SITE')
    expect(modelLine({ model: 'SpaceLayer', name: '空间图层', table: 'SPACE_LAYER', may: ['add', 'search'], note: '图层配置' }))
      .toBe('SpaceLayer name=空间图层 table=SPACE_LAYER may=add,search note=图层配置')
  })

  it('renders a model listing under a heading saying what a line with no rights means', () => {
    const value: DomainModelsValue = {
      domain: 'TRANSO',
      name: '传输专业',
      models: [{ model: 'SITE' }],
      from: 0,
      shown: 1,
      total: 1,
      truncated: false,
    }
    expect(modelsHeading('TRANSO', '传输专业', 1)).toContain('may do nothing with')
    expect(renderDomainModels(value)).toBe(`${modelsHeading('TRANSO', '传输专业', 1)}\nSITE`)
  })

  it('leaves out every field of an attribute line this deployment states nothing for', () => {
    expect(attributeLine({ attribute: 'lonely' })).toBe('lonely')
    expect(attributeLine({
      attribute: 'state',
      name: '状态',
      type: 'VARCHAR',
      length: 8,
      key: false,
      nullable: false,
      default: '1',
      group: '基本信息',
      required: false,
      editable: true,
      forms: ['query', 'add'],
      picks: 'CITY',
      values: [{ stored: '1', shown: '在用' }],
    })).toBe('state name=状态 type=VARCHAR len=8 default=1 group=基本信息 forms=query,add picks=CITY values=1=在用')
  })

  it('writes the three flags only in the reading that tells a model something', () => {
    expect(attributeLine({ attribute: 'a', key: true, nullable: true, required: true, editable: false }))
      .toBe('a key=yes null=yes req=yes edit=no')
  })

  it('counts the fixed values left out at the end of the values it carries', () => {
    expect(attributeLine({ attribute: 'a', values: [{ stored: '1', shown: '在用' }], moreValues: 17 }))
      .toBe('a values=1=在用|+17 more')
  })

  it('renders a model read whose heading carries what the person may do with it', () => {
    const value: ModelValue = {
      model: 'SpaceLayer',
      name: '空间图层',
      domain: 'TRANSO',
      domainName: '传输专业',
      table: 'SPACE_LAYER',
      parent: 'ResBase',
      note: '图层配置',
      attributes: [{ attribute: 'zh_label' }],
      may: ['add', 'search'],
      editableColumns: ['zh_label'],
      from: 0,
      shown: 1,
      total: 1,
      truncated: false,
    }
    const heading = modelHeading(value)
    expect(heading.split('\n')[0])
      .toBe('Data model SpaceLayer (空间图层), filed under TRANSO (传输专业), rows stored in SPACE_LAYER, extending ResBase. 图层配置')
    expect(heading).toContain('The signed-in person may perform these operations on this model: add, search.')
    expect(heading).toContain('Editing is narrowed to these attributes: zh_label.')
    expect(renderModel(value)).toBe(`${heading}\nzh_label`)
  })

  it('says outright that a person may do nothing, and leaves out what this deployment does not state', () => {
    const heading = modelHeading({
      model: 'SITE',
      domain: 'TRANSO',
      domainName: '传输专业',
      attributes: [],
      may: [],
      from: 0,
      shown: 0,
      total: 0,
      truncated: false,
    })
    expect(heading.split('\n')[0]).toBe('Data model SITE, filed under TRANSO (传输专业).')
    expect(heading).toContain('The signed-in person may perform no operation on this model.')
    expect(heading).not.toContain('Editing is narrowed')
  })
})
