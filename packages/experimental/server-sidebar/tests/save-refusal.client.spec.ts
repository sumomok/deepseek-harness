/**
 * `save-refusal.ts`: the fixed copy for each way a save of the menu fails —
 * reaching no member's menu, a refusal that lists the fields naming someone
 * else's conversations, any other 4xx, and everything else — how the listed
 * fields are named from the patch the page sent, and the line the screen shows
 * for one workflow, more than one, and the workbench, in both languages.
 */
import { describe, expect, it } from 'vitest'
import { saveRefusalCopy } from '../src/client/save-refusal.ts'
import { ServerMenuRefusedError, ServerMenuUnplacedError, type ServerMenuPatch } from '../src/client/workflow-api.ts'
import { en, type ServerSidebarKey, type ServerSidebarTranslate, zh } from '../src/client/locales.ts'
import type { ServerMenuWorkflow } from '../src/workflows.ts'

/**
 * A dictionary's lookup, its `{name}` slots filled from the values.
 * @param dictionary - the dictionary looked up.
 * @returns the lookup.
 */
function lookup(dictionary: Readonly<Record<ServerSidebarKey, string>>): ServerSidebarTranslate {
  return (key, values = {}) => dictionary[key].replace(/\{(\w+)\}/gu, (_slot, name: string) => values[name] ?? '')
}

/** The English dictionary's lookup. */
const t = lookup(en)

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
      .toBe('the chats behind “Alpha”, “Beta”, “Workbench” are someone else’s; the change was not saved')
  })

  it('leaves out a path it cannot name, and falls back to the not-accepted copy when none is left', () => {
    expect(saveRefusalCopy(refused(400, ['workflows[2].homeSessionId', 'groups', 'workbenchSessionId']), SENT, t))
      .toBe('the chat behind “Workbench” is someone else’s; the change was not saved')
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

describe('the line the screen shows for a refusal that names entries', () => {
  it.each([
    {
      entries: 'one workflow', language: 'zh', fields: ['workflows[0].homeSessionId'],
      line: '保存失败：「Alpha」指向别人的对话，请先把它移出列表再保存',
    },
    {
      entries: 'one workflow', language: 'en', fields: ['workflows[0].homeSessionId'],
      line: 'Failed to save: the chat behind “Alpha” is someone else’s; remove it from the list, then save again',
    },
    {
      entries: 'two workflows', language: 'zh', fields: ['workflows[0].homeSessionId', 'workflows[1].homeSessionId'],
      line: '保存失败：「Alpha」、「Beta」指向别人的对话，请先把它们移出列表再保存',
    },
    {
      entries: 'two workflows', language: 'en', fields: ['workflows[0].homeSessionId', 'workflows[1].homeSessionId'],
      line: 'Failed to save: the chats behind “Alpha”, “Beta” are someone else’s; remove them from the list, then save again',
    },
    {
      entries: 'a workflow and the workbench', language: 'zh', fields: ['workflows[1].homeSessionId', 'workbenchSessionId'],
      line: '保存失败：「Beta」、「工作台」指向别人的对话，这次修改没有保存',
    },
    {
      entries: 'a workflow and the workbench', language: 'en', fields: ['workflows[1].homeSessionId', 'workbenchSessionId'],
      line: 'Failed to save: the chats behind “Beta”, “Workbench” are someone else’s; the change was not saved',
    },
    {
      entries: 'the workbench alone', language: 'zh', fields: ['workbenchSessionId'],
      line: '保存失败：「工作台」指向别人的对话，这次修改没有保存',
    },
    {
      entries: 'the workbench alone', language: 'en', fields: ['workbenchSessionId'],
      line: 'Failed to save: the chat behind “Workbench” is someone else’s; the change was not saved',
    },
  ] as const)('names $entries in $language', ({ language, fields, line }) => {
    const dictionary = { zh, en }[language]
    const shown = dictionary['workflows.error'].replace('{message}', saveRefusalCopy(refused(400, fields), SENT, lookup(dictionary)))
    expect(shown).toBe(line)
    expect(shown).not.toMatch(/homeSessionId|workbenchSessionId|server-sidebar:|session|会话/iu)
  })
})
