import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import {
  findRegistryViolations,
  lineCommits,
  parseRegistry,
  REGISTRY_PATH,
  runCheck,
  type LineCommit,
  type Registry,
} from './verify-core-patches.ts'

const LINE = 'core-patches-test'

const REGISTRY = `# core-patches 补丁登记

**当前补丁线**：\`${LINE}\`，基座 \`upstream/master\`。

## 身份规则

不是补丁记录的小节不参与登记。

## alpha-seam — An alpha seam

- **改了什么**：alpha。
- **状态**：在役（${LINE}）

## beta-seat — A beta seat

- **改了什么**：beta。
- **状态**：退役（上游 PR #1）
`

function commit(id: string, ...slugs: string[]): LineCommit {
  return { id, subject: `subject ${id}`, parents: 1, slugs }
}

/**
 * Build a throwaway git repository whose HEAD sits on the declared patch line
 * above a `refs/remotes/upstream/master` base, so the halves of this check that
 * read git can be driven end to end.
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
        GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
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
  const base = record('base')
  git(['update-ref', 'refs/remotes/upstream/master', base])
  write(REGISTRY_PATH, registry)
  return { root, git, write, record, base }
}

describe('parseRegistry', () => {
  it('reads the declared line, slug, title and status, and ignores declared prose headings', () => {
    expect(parseRegistry(REGISTRY)).toEqual<Registry>({
      declaredLine: LINE,
      malformedHeadings: [],
      records: [
        { slug: 'alpha-seam', title: 'An alpha seam', status: '在役' },
        { slug: 'beta-seat', title: 'A beta seat', status: '退役' },
      ],
    })
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
      detail: `${REGISTRY_PATH} records alpha-seam as 在役, but no commit above upstream/master names it.`,
    }])
  })

  it('requires a commit for a partly retired record too', () => {
    const partial = parseRegistry('## alpha-seam — One\n- **状态**：局部退役（core-patches-v10）\n')
    expect(findRegistryViolations([], partial)).toEqual([{
      kind: 'unused-active-slug',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 局部退役, but no commit above upstream/master names it.`,
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

describe('lineCommits', () => {
  it('reads only the trailer git reads, in the message\'s last paragraph', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('mid-message\n\nPatch: alpha-seam\n\nprose after the trailer block')
    fixture.record('lower case key\n\npatch: alpha-seam')
    fixture.record('quoted example\n\nA commit writes\nPatch: some-example\nin its last paragraph.\n\nPatch: alpha-seam')

    expect(lineCommits(fixture.root).map(entry => [entry.subject, entry.slugs])).toEqual([
      ['registry', ['alpha-seam']],
      // git reads the last paragraph only; prose after it makes the line invisible.
      ['mid-message', []],
      // git's trailer key match is case-insensitive.
      ['lower case key', ['alpha-seam']],
      // A quoted example line sits in an earlier paragraph, so it is not a trailer.
      ['quoted example', ['alpha-seam']],
    ])
  })

  it('counts a merge commit\'s parents', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    const line = fixture.git(['rev-parse', 'HEAD'])
    fixture.git(['checkout', '--quiet', '-b', 'side', fixture.base])
    fixture.write('side.md', 'side\n')
    fixture.record('side\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge side\n\nPatch: alpha-seam', 'side'])

    const commits = lineCommits(fixture.root)
    expect(commits.map(entry => entry.parents)).toEqual([1, 1, 2])
    expect(commits.at(-1)!.id).toHaveLength(10)
    expect(line).not.toBe(fixture.base)
  })
})

describe('runCheck', () => {
  it('agrees when every commit names a registered, active slug', (test) => {
    const fixture = repository(test)
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

  it('rejects an upstream ref that is no longer this line\'s base', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['update-ref', 'refs/remotes/upstream/master', fixture.git(['rev-parse', 'HEAD'])])
    fixture.write('after.md', 'after\n')
    fixture.git(['checkout', '--quiet', '-b', 'moved', fixture.base])
    fixture.record('upstream moved on')
    fixture.git(['update-ref', 'refs/remotes/upstream/master', fixture.git(['rev-parse', 'HEAD'])])
    fixture.git(['checkout', '--quiet', LINE])

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('not this line\'s base')
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

  it('skips a checkout with no upstream ref', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['update-ref', '-d', 'refs/remotes/upstream/master'])
    expect(runCheck(fixture.root)).toEqual({ status: 'skipped', report: 'skipped: no upstream/master ref' })
  })

  it('reports a missing registry in one line', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    rmSync(join(fixture.root, REGISTRY_PATH))
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toBe(`${REGISTRY_PATH} is missing or unreadable; the patch line has no registry to check against.`)
  })

  it('reports a registry that declares no patch line', (test) => {
    const fixture = repository(test, REGISTRY.split('\n').filter(line => !line.startsWith('**当前补丁线**')).join('\n'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('declares no 当前补丁线')
  })
})
