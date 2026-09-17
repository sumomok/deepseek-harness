import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import {
  declaredBaseCommits,
  findRegistryViolations,
  isShallowClone,
  lineCommits,
  parseRegistry,
  REGISTRY_PATH,
  runCheck,
  type LineCommit,
  type Registry,
} from './verify-core-patches.ts'

const LINE = 'core-patches-test'
const BASE_PULL_REQUEST = '4192'

const REGISTRY = `# core-patches 补丁登记

**当前补丁线**：\`${LINE}\`。

**基座合并**：#${BASE_PULL_REQUEST}

## 身份规则

不是补丁记录的小节不参与登记。

## alpha-seam — An alpha seam

- **改了什么**：alpha。
- **状态**：在役（${LINE}）

## beta-seat — A beta seat

- **改了什么**：beta。
- **状态**：退役（上游 PR #1）
`

let configRoot = ''
let inherited: { global: string | undefined; noSystem: string | undefined } = { global: undefined, noSystem: undefined }

beforeAll(() => {
  // The halves of this check that read git run in this process and would
  // otherwise inherit the machine's git configuration, where `trailer.*` and
  // `log.*` settings change what `%(trailers)` and `git log` produce. Every
  // run — the fixtures' and the code under test's — reads one empty config.
  configRoot = mkdtempSync(join(tmpdir(), 'dsh-core-patches-config-'))
  writeFileSync(join(configRoot, 'global.gitconfig'), '')
  inherited = { global: process.env.GIT_CONFIG_GLOBAL, noSystem: process.env.GIT_CONFIG_NOSYSTEM }
  process.env.GIT_CONFIG_GLOBAL = join(configRoot, 'global.gitconfig')
  process.env.GIT_CONFIG_NOSYSTEM = '1'
})

afterAll(() => {
  if (inherited.global === undefined) delete process.env.GIT_CONFIG_GLOBAL
  else process.env.GIT_CONFIG_GLOBAL = inherited.global
  if (inherited.noSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM
  else process.env.GIT_CONFIG_NOSYSTEM = inherited.noSystem
  rmSync(configRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

function commit(id: string, ...slugs: string[]): LineCommit {
  return { id, subject: `subject ${id}`, parents: 1, slugs }
}

/**
 * Build a throwaway git repository whose HEAD sits on the declared patch line
 * above a merge commit for the declared pull request, so the halves of this
 * check that read git can be driven end to end. The repository has no remote
 * and no remote-tracking ref: the base is resolved from HEAD's own history.
 * @param test - the running test, used to remove the repository afterwards.
 * @param registry - the registry file contents to write, defaulting to the fixture above.
 * @returns the repository root and helpers for writing files and commits.
 */
function repository(test: TestContext, registry: string = REGISTRY) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-core-patches-'))
  test.onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Core patch test',
        GIT_AUTHOR_EMAIL: 'core-patch@example.invalid',
        GIT_COMMITTER_NAME: 'Core patch test',
        GIT_COMMITTER_EMAIL: 'core-patch@example.invalid',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  }
  function write(file: string, source: string): void {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  /**
   * Commit every pending change with one message.
   * @param message - the complete commit message, trailers included.
   * @returns the new commit's full id.
   */
  function record(message: string): string {
    git(['add', '--all'])
    git(['commit', '--quiet', '--allow-empty', '-m', message])
    return git(['rev-parse', 'HEAD'])
  }
  git(['init', '--quiet', '--initial-branch', LINE])
  write('base.md', 'base\n')
  record('root')
  git(['checkout', '--quiet', '-b', 'upstream-topic'])
  write('upstream.md', 'upstream\n')
  record('upstream: a change with no trailer')
  git(['checkout', '--quiet', LINE])
  git(['merge', '--quiet', '--no-ff', '-m', `Merge pull request #${BASE_PULL_REQUEST} from upstream/topic`, 'upstream-topic'])
  const base = git(['rev-parse', 'HEAD'])
  write(REGISTRY_PATH, registry)
  return { root, git, write, record, base }
}

describe('parseRegistry', () => {
  it('reads both declarations, and each record\'s slug, title and status', () => {
    expect(parseRegistry(REGISTRY)).toEqual<Registry>({
      declaredLines: [LINE],
      declaredBases: [BASE_PULL_REQUEST],
      malformedHeadings: [],
      records: [
        { slug: 'alpha-seam', title: 'An alpha seam', status: '在役' },
        { slug: 'beta-seat', title: 'A beta seat', status: '退役' },
      ],
    })
  })

  it('reads a file written with CRLF line endings', () => {
    expect(parseRegistry(REGISTRY.replace(/\n/gu, '\r\n'))).toEqual(parseRegistry(REGISTRY))
  })

  it('reads nothing out of a fenced example', () => {
    const fenced = REGISTRY.replace('不是补丁记录的小节不参与登记。', [
      '```md',
      '**当前补丁线**：`core-patches-v1`',
      '**基座合并**：#1',
      '## example-slug — 示例记录',
      '- **状态**：在役',
      '```',
      '',
      '~~~',
      '## another-example — 另一个示例',
      '~~~',
    ].join('\n'))
    expect(parseRegistry(fenced)).toEqual(parseRegistry(REGISTRY))
  })

  it('collects a repeated declaration rather than keeping the first', () => {
    const repeated = REGISTRY.replace(`**基座合并**：#${BASE_PULL_REQUEST}`, `**基座合并**：#${BASE_PULL_REQUEST}\n\n**基座合并**：#7`)
    expect(parseRegistry(repeated).declaredBases).toEqual([BASE_PULL_REQUEST, '7'])
  })

  it('keeps the first status of a record and never carries one past a plain heading', () => {
    const source = [
      '## alpha-seam — An alpha seam', '- **状态**：在役', '- **状态**：退役', '## 身份规则', '- **状态**：在役', '',
    ].join('\n')
    expect(parseRegistry(source).records).toEqual([
      { slug: 'alpha-seam', title: 'An alpha seam', status: '在役' },
    ])
  })

  it('reports a record that declares no status', () => {
    expect(parseRegistry('## alpha-seam — An alpha seam\n\nno status line\n').records)
      .toEqual([{ slug: 'alpha-seam', title: 'An alpha seam', status: null }])
  })

  it('reports a heading that is neither a record nor a declared prose section', () => {
    // A hyphen where the record format wants an em dash, which would otherwise
    // drop the record and every check that depends on it.
    const parsed = parseRegistry('## alpha-seam - An alpha seam\n- **状态**：在役\n')
    expect(parsed.records).toEqual([])
    expect(parsed.malformedHeadings).toEqual(['alpha-seam - An alpha seam'])
  })
})

describe('findRegistryViolations', () => {
  const registry = parseRegistry(REGISTRY)

  it('accepts a line whose commits name registered slugs and cover every active record', () => {
    expect(findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], registry)).toEqual([])
  })

  it('accepts a retired record with no commit on the line', () => {
    const violations = findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], registry)
    expect(violations.some(violation => violation.subject === 'beta-seat')).toBe(false)
  })

  it('rejects a retired record whose commits are still on the line', () => {
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'beta-seat')],
      registry,
    )
    expect(violations).toEqual([{
      kind: 'retired-slug-in-use',
      subject: 'beta-seat',
      detail: `${REGISTRY_PATH} records beta-seat as 退役, but bbbbbbbbbb still names it; a retired patch is off the line, not only off the registry.`,
    }])
  })

  it('rejects a commit with no trailer and one with two', () => {
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa'), commit('bbbbbbbbbb', 'alpha-seam', 'beta-seat')],
      registry,
    )
    expect(violations.map(violation => violation.kind)).toEqual(['trailer-count', 'trailer-count', 'unused-active-slug'])
    expect(violations[0]!.detail).toContain('carries 0 Patch trailers')
    expect(violations[1]!.detail).toContain('carries 2 Patch trailers')
  })

  it('rejects a trailer value that is not a slug', () => {
    // git takes any trailer value, including one folded across lines, which
    // unfolds to a value with a space in it.
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'alpha-seam continued')],
      registry,
    )
    expect(violations.map(violation => violation.kind)).toEqual(['malformed-trailer'])
    expect(violations[0]!.detail).toContain('is not a slug')
  })

  it('rejects a merge commit whatever trailers it carries', () => {
    const merge: LineCommit = { id: 'cccccccccc', subject: 'merge', parents: 2, slugs: ['alpha-seam'] }
    const violations = findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam'), merge], registry)
    expect(violations.map(violation => violation.kind)).toEqual(['merge-commit'])
    expect(violations[0]!.detail).toContain('stays linear')
  })

  it('rejects a slug the registry does not register', () => {
    const violations = findRegistryViolations(
      [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'gamma-row')],
      registry,
    )
    expect(violations).toEqual([{
      kind: 'unregistered-slug',
      subject: 'bbbbbbbbbb',
      detail: `bbbbbbbbbb (subject bbbbbbbbbb) names Patch: gamma-row, which ${REGISTRY_PATH} does not register.`,
    }])
  })

  it('rejects an active record no commit names', () => {
    const violations = findRegistryViolations([], registry)
    expect(violations).toEqual([{
      kind: 'unused-active-slug',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 在役, but no commit on this line names it.`,
    }])
  })

  it('requires a commit for a partly retired record too', () => {
    const partial = parseRegistry('## alpha-seam — One\n- **状态**：局部退役（core-patches-v10）\n')
    expect(findRegistryViolations([], partial)).toEqual([{
      kind: 'unused-active-slug',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 局部退役, but no commit on this line names it.`,
    }])
    expect(findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], partial)).toEqual([])
  })

  it('rejects a duplicated slug and a record without a status', () => {
    const duplicated = parseRegistry([
      '## alpha-seam — One', '- **状态**：在役', '',
      '## alpha-seam — Two', '- **状态**：在役', '',
      '## gamma-row — Three', '', 'no status', '',
    ].join('\n'))
    const violations = findRegistryViolations([commit('aaaaaaaaaa', 'alpha-seam')], duplicated)
    expect(violations.map(violation => violation.kind)).toEqual(['duplicate-slug', 'missing-status'])
  })

  it('reports a malformed heading before anything else', () => {
    const malformed = parseRegistry('## alpha-seam - One\n- **状态**：在役\n')
    expect(findRegistryViolations([], malformed).map(violation => violation.kind)).toEqual(['malformed-heading'])
  })
})

describe('declaredBaseCommits', () => {
  it('resolves the declared merge from HEAD\'s own history', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(declaredBaseCommits(fixture.root, BASE_PULL_REQUEST)).toEqual([fixture.base])
    // No remote-tracking ref exists at all, so nothing but the declaration and
    // HEAD's history can have produced that answer.
    expect(fixture.git(['for-each-ref', '--format=%(refname)', 'refs/remotes'])).toBe('')
  })

  it('matches neither an absent pull request nor a number the declared one only starts with', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(declaredBaseCommits(fixture.root, '9999')).toEqual([])
    expect(declaredBaseCommits(fixture.root, BASE_PULL_REQUEST.slice(0, 3))).toEqual([])
  })
})

describe('lineCommits', () => {
  it('reads only the trailer git reads, in the message\'s last paragraph', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('mid-message\n\nPatch: alpha-seam\n\nprose after the trailer block')
    fixture.record('lower case key\n\npatch: alpha-seam')
    fixture.record('quoted example\n\nA commit writes\nPatch: some-example\nin its last paragraph.\n\nPatch: alpha-seam')
    fixture.record('folded value\n\nPatch: alpha-seam\n  continued')

    expect(lineCommits(fixture.root, fixture.base).map(entry => [entry.subject, entry.slugs])).toEqual([
      ['registry', ['alpha-seam']],
      // git reads the last paragraph only; prose after it makes the line invisible.
      ['mid-message', []],
      // git's trailer key match is case-insensitive.
      ['lower case key', ['alpha-seam']],
      // A quoted example line sits in an earlier paragraph, so it is not a trailer.
      ['quoted example', ['alpha-seam']],
      // A folded value unfolds to one line, so no finding can be split in two.
      ['folded value', ['alpha-seam continued']],
    ])
  })

  it('counts a merge commit\'s parents and excludes the base', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'side', fixture.base])
    fixture.write('side.md', 'side\n')
    fixture.record('side\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge side\n\nPatch: alpha-seam', 'side'])

    const commits = lineCommits(fixture.root, fixture.base)
    expect(commits.map(entry => entry.parents)).toEqual([1, 1, 2])
    expect(commits.at(-1)!.id).toHaveLength(10)
    expect(commits.some(entry => entry.subject.startsWith('Merge pull request'))).toBe(false)
  })
})

describe('runCheck', () => {
  it('agrees when every commit names a registered, active slug', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root)).toEqual({ status: 'ok', report: '1 commit(s) and 2 registry record(s) agree.' })
  })

  it('reads the base through a fenced example without taking the example\'s declarations', (test) => {
    const fenced = REGISTRY.replace('不是补丁记录的小节不参与登记。', [
      '```md', '**当前补丁线**：`core-patches-v1`', '**基座合并**：#1', '## example-slug — 示例记录', '```',
    ].join('\n'))
    const fixture = repository(test, fenced)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root)).toEqual({ status: 'ok', report: '1 commit(s) and 2 registry record(s) agree.' })
  })

  it('rejects a merge commit on the line', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'side', fixture.base])
    fixture.write('side.md', 'side\n')
    fixture.record('side\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge side\n\nPatch: alpha-seam', 'side'])

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('merge-commit:')
  })

  it('rejects a retired slug whose commit is still on the line', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('retired work\n\nPatch: beta-seat')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('retired-slug-in-use:')
  })

  it('rejects a record whose heading the format cannot parse', (test) => {
    const fixture = repository(test, REGISTRY.replace('## alpha-seam — An alpha seam', '## alpha-seam - An alpha seam'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('malformed-heading:')
    // Without the report the record would vanish and the commit's slug would
    // read as unregistered instead of as a typo in the heading.
    expect(result.report).toContain('unregistered-slug:')
  })

  it('rejects a trailer git cannot see', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam\n\nprose after the trailer block')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('carries 0 Patch trailers')
  })

  it('rejects a second trailer on one commit', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam\nPatch: beta-seat')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('carries 2 Patch trailers')
  })

  it('rejects a trailer value git accepts and the slug format does not', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('spaced value\n\nPatch: alpha seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('malformed-trailer:')
    expect(result.report.split('\n').filter(line => line.includes('malformed-trailer'))).toHaveLength(1)
  })

  it('rejects a folded trailer value in one line of report', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('folded value\n\nPatch: alpha-seam\n  continued')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('Patch: alpha-seam continued')
    expect(result.report.split('\n')).toHaveLength(2)
  })

  it('rejects a declared base merge this line\'s history does not contain', (test) => {
    const fixture = repository(test, REGISTRY.replace(`#${BASE_PULL_REQUEST}`, '#9999'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('#9999')
    expect(result.report).toContain('not in this line\'s history')
  })

  it('rejects a declared base merge more than one commit claims', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'second-topic'])
    fixture.write('second.md', 'second\n')
    fixture.record('upstream: another change')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', `Merge pull request #${BASE_PULL_REQUEST} from upstream/again`, 'second-topic'])

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('2 merge commits in this line\'s history claim')
  })

  it('skips a checkout that is not on the declared line', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    fixture.record('no trailer here, and none is wanted')
    expect(runCheck(fixture.root)).toEqual({
      status: 'skipped',
      report: `skipped: not on the declared patch line ${LINE} (develop)`,
    })
  })

  it('skips a detached HEAD', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '--detach'])
    expect(runCheck(fixture.root).report).toContain('(detached HEAD)')
  })

  it('skips a shallow clone, whose history cannot reach the declared merge', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    const clone = join(mkdtempSync(join(tmpdir(), 'dsh-core-patches-clone-')), 'shallow')
    test.onTestFinished(() => {
      rmSync(dirname(clone), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    })
    fixture.git(['clone', '--quiet', '--depth', '1', `file://${fixture.root}`, clone])

    expect(isShallowClone(clone)).toBe(true)
    expect(declaredBaseCommits(clone, BASE_PULL_REQUEST)).toEqual([])
    const result = runCheck(clone)
    expect(result.status).toBe('skipped')
    expect(result.report).toContain('shallow clone')
  })

  it('reports a missing registry in one line, on the patch line and off it', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    rmSync(join(fixture.root, REGISTRY_PATH))
    const onLine = runCheck(fixture.root)
    expect(onLine.status).toBe('failed')
    expect(onLine.report).toBe(`${REGISTRY_PATH} is missing or unreadable; the patch line has no registry to check against.`)
    // The registry names the branch the check compares against, so losing it
    // is a failure everywhere rather than a skip anywhere.
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    expect(runCheck(fixture.root).status).toBe('failed')
  })

  it('reports a registry that declares no patch line, and one that declares two', (test) => {
    const fixture = repository(test, REGISTRY.split('\n').filter(line => !line.startsWith('**当前补丁线**')).join('\n'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const none = runCheck(fixture.root)
    expect(none.status).toBe('failed')
    expect(none.report).toContain('declares 当前补丁线 0 time(s)')

    fixture.write(REGISTRY_PATH, REGISTRY.replace(`**当前补丁线**：\`${LINE}\`。`, `**当前补丁线**：\`${LINE}\`。\n\n**当前补丁线**：\`other\`。`))
    const two = runCheck(fixture.root)
    expect(two.status).toBe('failed')
    expect(two.report).toContain('declares 当前补丁线 2 time(s)')
  })

  it('reports a registry that declares no base merge, and one that declares two', (test) => {
    const fixture = repository(test, REGISTRY.split('\n').filter(line => !line.startsWith('**基座合并**')).join('\n'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const none = runCheck(fixture.root)
    expect(none.status).toBe('failed')
    expect(none.report).toContain('declares 基座合并 0 time(s)')

    fixture.write(REGISTRY_PATH, REGISTRY.replace(`**基座合并**：#${BASE_PULL_REQUEST}`, `**基座合并**：#${BASE_PULL_REQUEST}\n\n**基座合并**：#7`))
    const two = runCheck(fixture.root)
    expect(two.status).toBe('failed')
    expect(two.report).toContain('declares 基座合并 2 time(s)')
  })

  it('reports a failed git command in one line', (test) => {
    const plain = mkdtempSync(join(tmpdir(), 'dsh-core-patches-plain-'))
    test.onTestFinished(() => {
      rmSync(plain, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    })
    mkdirSync(dirname(join(plain, REGISTRY_PATH)), { recursive: true })
    writeFileSync(join(plain, REGISTRY_PATH), REGISTRY)

    const result = runCheck(plain)
    expect(result.status).toBe('failed')
    expect(result.report.split('\n')).toHaveLength(1)
    expect(result.report).toContain('git branch --show-current failed:')
  })
})
