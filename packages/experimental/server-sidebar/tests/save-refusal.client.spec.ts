/**
 * `save-refusal.ts`: the fixed copy for each way a save of the menu fails —
 * reaching no member's menu, a refusal that lists the fields naming someone
 * else's conversations, any other 4xx, and everything else — and how the
 * listed fields are named from the patch the page sent.
 */
import { describe, expect, it } from 'vitest'
import { saveRefusalCopy } from '../src/client/save-refusal.ts'
import { ServerMenuRefusedError, ServerMenuUnplacedError, type ServerMenuPatch } from '../src/client/workflow-api.ts'
import { en, type ServerSidebarKey } from '../src/client/locales.ts'
import type { ServerMenuWorkflow } from '../src/workflows.ts'

/**
 * The English dictionary's lookup, its `{name}` slots filled from the values.
 * @param key - the dictionary key.
 * @param values - the slot values.
 * @returns the filled copy.
 */
function t(key: ServerSidebarKey, values: Record<string, string> = {}): string {
  return en[key].replace(/\{(\w+)\}/gu, (_slot, name: string) => values[name] ?? '')
}

/**
 * A workflow of the sent list.
 * @param id - its id.
 * @param name - its name.
 * @returns the workflow.
 */
function workflow(id: string, name: string): ServerMenuWorkflow {
  return { id, name, order: 0, homeSessionId: `session-${id}`, navSnapshot: [], savedAt: 1 }
}

const SENT: ServerMenuPatch = { workflows: [workflow('w1', 'Alpha'), workflow('w2', 'Beta')], workbenchSessionId: 'session-x' }
const FOREIGN_TEXT = 'server-sidebar: workflows[1].homeSessionId names a conversation that belongs to another member'

/**
 * A refusal the route answered.
 * @param status - its HTTP status.
 * @param fields - the field paths it lists, if any.
 * @returns the error `saveServerMenu` throws for it.
 */
function refused(status: number, fields?: readonly string[]): ServerMenuRefusedError {
  return new ServerMenuRefusedError(FOREIGN_TEXT, status, fields)
}

describe('saveRefusalCopy', () => {
  it('asks for a reload where the save reached no member\'s menu', () => {
    expect(saveRefusalCopy(new ServerMenuUnplacedError('unplaced', 401), SENT, t)).toBe(en['workflows.retry'])
  })

  it('names each listed workflow by the name the page sent at that index, and the workbench by its label', () => {
    expect(saveRefusalCopy(refused(400, ['workflows[1].homeSessionId']), SENT, t))
      .toBe('the chat behind “Beta” is someone else’s; remove it from the list, then save again')
    expect(saveRefusalCopy(refused(400, ['workflows[0].homeSessionId', 'workflows[1].homeSessionId', 'workbenchSessionId']), SENT, t))
      .toBe('the chat behind “Alpha”, “Beta”, “Workbench” is someone else’s; remove it from the list, then save again')
  })

  it('leaves out a path it cannot name, and falls back to the not-accepted copy when none is left', () => {
    expect(saveRefusalCopy(refused(400, ['workflows[2].homeSessionId', 'groups', 'workbenchSessionId']), SENT, t))
      .toBe('the chat behind “Workbench” is someone else’s; remove it from the list, then save again')
    for (const [fields, sent] of [
      [['workflows[2].homeSessionId', 'workflows[0].name', 'groups'], SENT],
      [['workflows[0].homeSessionId'], { workbenchSessionId: 'session-x' }],
      [[], SENT],
    ] as const) {
      expect({ fields, copy: saveRefusalCopy(refused(400, fields), sent, t) }).toEqual({ fields, copy: en['workflows.refused'] })
    }
  })

  it('answers the not-accepted copy for every other 4xx, fields or not', () => {
    for (const [status, fields] of [[400, undefined], [409, ['workbenchSessionId']], [413, undefined], [499, undefined]] as const) {
      expect({ status, copy: saveRefusalCopy(refused(status, fields), SENT, t) }).toEqual({ status, copy: en['workflows.refused'] })
    }
  })

  it('answers the try-later copy for a 5xx, a status below 400, and a failure that is no refusal', () => {
    for (const error of [refused(500), refused(503, ['workbenchSessionId']), refused(302), new TypeError('Failed to fetch'), 'transport exploded']) {
      expect({ error, copy: saveRefusalCopy(error, SENT, t) }).toEqual({ error, copy: en['workflows.later'] })
    }
  })
})
