/**
 * The one-time converter behind the `convert-nav-snapshot` package script: what it
 * rewrites in each of the two settings formats, what it leaves exactly as it
 * found it, and what `--dry-run` withholds. The refusal that sends an operator
 * here is asserted in `workflows.client.spec.ts`; that this converter's output
 * is what the schema then accepts is asserted there too.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { changedAnything, convertSettingsFile, convertSettingsText, resolveFormat } from '../src/nav-snapshot-migration.ts'

const LEGACY_YAML = `# an operator's own note
server-sidebar:
  workbenchSessionId: s0
  workflows:
    - id: w1
      name: Alpha
      order: 0
      homeSessionId: s1
      navSnapshot:
        - home
        - reports
      savedAt: 1
`

/** Write one settings document into a fresh temporary directory. */
async function writeDocument(basename: string, text: string): Promise<string> {
  const filename = join(await mkdtemp(join(tmpdir(), 'dsh-nav-snapshot-')), basename)
  await writeFile(filename, text, 'utf8')
  return filename
}

describe('resolveFormat', () => {
  it('accepts the three extensions the settings file provider serves', () => {
    expect(resolveFormat('/x/settings.yaml')).toBe('yaml')
    expect(resolveFormat('/x/settings.yml')).toBe('yaml')
    expect(resolveFormat('/x/settings.json')).toBe('json')
  })

  it('refuses an extension that provider never serves', () => {
    expect(() => resolveFormat('/x/settings.toml')).toThrow(/is not a settings document \(use \.yaml, \.yml, or \.json\)/)
  })
})

describe('convertSettingsText, YAML', () => {
  it('rewrites every stored id as a page stop and adds the groups list', () => {
    const outcome = convertSettingsText(LEGACY_YAML, 'yaml')
    expect(outcome.converted).toBe(1)
    expect(outcome.groupsSeeded).toBe(true)
    const section = (parse(outcome.text) as { 'server-sidebar': { workflows: { navSnapshot: unknown }[]; groups: unknown } })['server-sidebar']
    expect(section.workflows[0]?.navSnapshot).toEqual([
      { kind: 'page', entryId: 'home' },
      { kind: 'page', entryId: 'reports' },
    ])
    expect(section.groups).toEqual([])
  })

  it('keeps the operator\'s own comments', () => {
    expect(convertSettingsText(LEGACY_YAML, 'yaml').text).toContain("# an operator's own note")
  })

  it('leaves a document that is already current byte-identical', () => {
    const current = LEGACY_YAML.replace('        - home\n        - reports\n', '        - { kind: page, entryId: home }\n')
      .replace('  workflows:', '  groups: []\n  workflows:')
    const outcome = convertSettingsText(current, 'yaml')
    expect(outcome).toEqual({ converted: 0, groupsSeeded: false, text: current })
    expect(changedAnything(outcome)).toBe(false)
  })

  it('adds the groups list on its own when only that key is missing', () => {
    const current = LEGACY_YAML.replace('        - home\n        - reports\n', '        - { kind: page, entryId: home }\n')
    const outcome = convertSettingsText(current, 'yaml')
    expect(outcome.converted).toBe(0)
    expect(outcome.groupsSeeded).toBe(true)
    expect(changedAnything(outcome)).toBe(true)
  })

  it('leaves an empty snapshot alone: it is already valid under both formats', () => {
    const outcome = convertSettingsText('server-sidebar:\n  groups: []\n  workflows:\n    - id: w1\n      navSnapshot: []\n', 'yaml')
    expect(outcome.converted).toBe(0)
  })

  it('leaves a mixed snapshot for the schema to refuse by entry', () => {
    const outcome = convertSettingsText(
      'server-sidebar:\n  groups: []\n  workflows:\n    - id: w1\n      navSnapshot:\n        - home\n        - { kind: view, entryId: sales }\n',
      'yaml',
    )
    expect(outcome.converted).toBe(0)
  })

  it('leaves a document with no server-sidebar section untouched', () => {
    const text = 'some-other-plugin:\n  value: 1\n'
    expect(convertSettingsText(text, 'yaml')).toEqual({ converted: 0, groupsSeeded: false, text })
  })

  it('leaves a section whose workflows are not a list untouched but still seeds groups', () => {
    const outcome = convertSettingsText('server-sidebar:\n  workflows: nonsense\n', 'yaml')
    expect(outcome.converted).toBe(0)
    expect(outcome.groupsSeeded).toBe(true)
  })

  it('leaves an unusable groups value for the schema rather than overwriting it', () => {
    const outcome = convertSettingsText('server-sidebar:\n  groups: nonsense\n  workflows: []\n', 'yaml')
    expect(outcome.groupsSeeded).toBe(false)
    expect(changedAnything(outcome)).toBe(false)
  })

  it('leaves a document whose whole root is not an object untouched', () => {
    expect(convertSettingsText('- a\n- b\n', 'yaml').converted).toBe(0)
  })

  it('leaves a section that is not an object untouched', () => {
    expect(convertSettingsText('server-sidebar: nonsense\n', 'yaml')).toEqual({
      converted: 0, groupsSeeded: false, text: 'server-sidebar: nonsense\n',
    })
  })
})

describe('convertSettingsText, JSON', () => {
  it('rewrites the decoded document and re-serializes it', () => {
    const text = JSON.stringify({ 'server-sidebar': { workflows: [{ id: 'w1', navSnapshot: ['home'] }] } })
    const outcome = convertSettingsText(text, 'json')
    expect(outcome.converted).toBe(1)
    expect(JSON.parse(outcome.text)).toEqual({
      'server-sidebar': { workflows: [{ id: 'w1', navSnapshot: [{ kind: 'page', entryId: 'home' }] }], groups: [] },
    })
  })

  it('leaves a document that is already current byte-identical', () => {
    const text = JSON.stringify({ 'server-sidebar': { groups: [], workflows: [{ id: 'w1', navSnapshot: [] }] } })
    expect(convertSettingsText(text, 'json')).toEqual({ converted: 0, groupsSeeded: false, text })
  })

  it('lets a JSON syntax error out rather than reporting a silent no-op', () => {
    expect(() => convertSettingsText('{ not json', 'json')).toThrow(SyntaxError)
  })
})

describe('convertSettingsFile', () => {
  it('writes the converted document back', async () => {
    const filename = await writeDocument('settings.yaml', LEGACY_YAML)
    const outcome = await convertSettingsFile(filename, { dryRun: false })
    expect(outcome.converted).toBe(1)
    expect(await readFile(filename, 'utf8')).toBe(outcome.text)
  })

  it('writes nothing under --dry-run, while still reporting what it would do', async () => {
    const filename = await writeDocument('settings.yaml', LEGACY_YAML)
    const outcome = await convertSettingsFile(filename, { dryRun: true })
    expect(outcome.converted).toBe(1)
    expect(await readFile(filename, 'utf8')).toBe(LEGACY_YAML)
  })

  it('writes nothing when the document is already current', async () => {
    const text = JSON.stringify({ 'server-sidebar': { groups: [], workflows: [] } })
    const filename = await writeDocument('settings.json', text)
    expect(changedAnything(await convertSettingsFile(filename, { dryRun: false }))).toBe(false)
    expect(await readFile(filename, 'utf8')).toBe(text)
  })

  it('refuses a file the settings provider would never serve', async () => {
    await expect(convertSettingsFile('/x/settings.toml', { dryRun: true })).rejects.toThrow(/is not a settings document/)
  })
})
