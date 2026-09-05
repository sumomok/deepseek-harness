/**
 * The durable server-menu format in isolation: what the schema accepts, what
 * it refuses by name, and the cross-element constraints `validateServerMenu`
 * adds on top of it. `workflow-route.client.spec.ts` covers the same rules
 * reaching an operator through the real composition; this file covers the
 * message text a refusal has to carry, and the format's group half, which no
 * interface writes yet.
 */
import { describe, expect, it } from 'vitest'
import {
  NAV_SNAPSHOT_CONVERTER, ServerMenuSettingsSchema, TEMPORARY_GROUP_ID,
  legacyNavSnapshotMessage, validateServerMenu, type ServerMenuSettings,
} from '../src/workflows.ts'
import { convertSettingsText } from '../src/nav-snapshot-migration.ts'

/** One workflow carrying every required field, for the fields a case is not about. */
function workflow(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'w1', name: 'Alpha', order: 0, homeSessionId: 's1', navSnapshot: [], savedAt: 1, ...fields }
}

/** One group carrying every required field, for the fields a case is not about. */
function group(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'g1', name: '常用', pinned: false, order: 0, ...fields }
}

/**
 * Run one stored section through the schema the way the settings capability
 * does: a document read off a file, of no guaranteed shape.
 *
 * The cast is what lets these cases exist — the schema is annotated with the
 * section it PRODUCES, so its declared input is the already-valid type, while
 * every case here is about what it does with a document that is not one yet.
 * Confining the cast to this one helper keeps each fixture written exactly as
 * an operator's file would hold it.
 * @param section - the stored section, of whatever shape the case is about.
 * @returns the resolved section.
 */
function parse(section: unknown): ServerMenuSettings {
  return ServerMenuSettingsSchema(section as ServerMenuSettings)
}

/**
 * Read one stored section the way the settings capability does — schema
 * first, then the cross-element validation — as a thunk an expectation can run.
 * @param section - the stored section, of whatever shape the case is about.
 * @returns the thunk.
 */
function check(section: unknown): () => void {
  return () => { validateServerMenu(parse(section)) }
}

describe('the navSnapshot format', () => {
  it('accepts the stored kind/entryId pairs', () => {
    const [entry] = parse({
      workflows: [workflow({ navSnapshot: [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }] })],
    }).workflows
    expect(entry?.navSnapshot).toEqual([{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }])
  })

  it('refuses the pre-view string form, naming the entry and the converter', () => {
    expect(check({ workflows: [workflow({ navSnapshot: ['home'] })] }))
      .toThrow(/navSnapshot entry "home" is the pre-view string form/)
    expect(legacyNavSnapshotMessage('home')).toContain(NAV_SNAPSHOT_CONVERTER)
  })

  it('names a converter an operator can actually run', () => {
    expect(NAV_SNAPSHOT_CONVERTER).toContain('run convert-nav-snapshot')
    expect(NAV_SNAPSHOT_CONVERTER).toContain('--dry-run')
  })

  it('accepts exactly what that converter produces out of a refused document', () => {
    const legacy = { 'server-sidebar': { workflows: [workflow({ navSnapshot: ['home', 'reports'] })] } }
    const converted = JSON.parse(convertSettingsText(JSON.stringify(legacy), 'json').text) as { 'server-sidebar': unknown }
    const value = parse(converted['server-sidebar'])
    expect(value.workflows[0]?.navSnapshot).toEqual([{ kind: 'page', entryId: 'home' }, { kind: 'page', entryId: 'reports' }])
    expect(value.groups).toEqual([])
  })

  it('refuses a kind neither catalog can produce', () => {
    expect(check({ workflows: [workflow({ navSnapshot: [{ kind: 'chart', entryId: 'c1' }] })] })).toThrow()
  })
})

describe('the group format', () => {
  it('defaults an absent groups list to empty and an absent pinned to false', () => {
    expect(parse({}).groups).toEqual([])
    expect(parse({ groups: [{ id: 'g1', name: '常用', order: 0 }] }).groups[0]?.pinned).toBe(false)
  })

  it('accepts a workflow filed under a stored group', () => {
    expect(check({ groups: [group()], workflows: [workflow({ groupId: 'g1' })] })).not.toThrow()
  })

  it('accepts a workflow filed under the reserved temporary group, which is never stored', () => {
    expect(check({ workflows: [workflow({ groupId: TEMPORARY_GROUP_ID })] })).not.toThrow()
  })

  it('refuses a stored group claiming the reserved id', () => {
    expect(check({ groups: [group({ id: TEMPORARY_GROUP_ID })] }))
      .toThrow(`group id "${TEMPORARY_GROUP_ID}" is reserved and cannot be stored`)
  })

  it('reserves an id no generated group id can collide with', () => {
    expect(TEMPORARY_GROUP_ID).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/)
  })

  it('refuses two groups sharing an id', () => {
    expect(check({ groups: [group(), group({ name: '别的' })] })).toThrow('duplicate group id "g1"')
  })

  it('refuses a group with a blank name, which would draw a row nobody can read', () => {
    expect(check({ groups: [group({ name: '   ' })] })).toThrow('group "g1" has a blank name')
  })

  it('refuses a group name past the field\'s own ceiling', () => {
    expect(check({ groups: [group({ name: 'x'.repeat(41) })] }))
      .toThrow('group "g1" has a name longer than 40 characters')
  })

  it('accepts a group name exactly at that ceiling', () => {
    expect(check({ groups: [group({ name: 'x'.repeat(40) })] })).not.toThrow()
  })

  it('refuses a workflow filed under a group nothing defines', () => {
    expect(check({ workflows: [workflow({ groupId: 'gone' })] }))
      .toThrow('workflow "w1" names group "gone", which no group defines')
  })
})

describe('validateServerMenu', () => {
  it('refuses two workflows sharing an id', () => {
    expect(check({ workflows: [workflow(), workflow({ name: 'Beta' })] })).toThrow('duplicate workflow id "w1"')
  })

  it('accepts an empty document', () => {
    expect(check({})).not.toThrow()
  })
})
