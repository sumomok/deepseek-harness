import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, type TestContext } from 'vitest'
import {
  changedPaths,
  findRegistryViolations,
  isShallowClone,
  lineCommits,
  lineMerges,
  parseRegistry,
  REGISTRY_PATH,
  releaseCommits,
  runCheck,
  tagCommit,
  type LineCommit,
  type PatchLine,
  type Registry,
} from './verify-core-patches.ts'

const LINE = 'core-patches-test'
const BASE_TAG = 'dsh-v1.0.0'

/**
 * Write the registry fixture.
 * @param tag - the base tag it declares.
 * @returns the registry file contents.
 */
function registryFor(tag: string): string {
  return `# core-patches 补丁登记

**当前补丁线**：\`${LINE}\`。

**基座 tag**：\`${tag}\`

## 身份规则

不是补丁记录的小节不参与登记。

## alpha-seam — An alpha seam

- **改了什么**：alpha。
- **状态**：在役（${LINE}）
- **路径**：\`alpha/**\` \`${REGISTRY_PATH}\`

## beta-seat — A beta seat

- **改了什么**：beta。
- **状态**：退役（上游 PR #1）
`
}

const REGISTRY = registryFor(BASE_TAG)

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
  return { id, subject: `subject ${id}`, slugs }
}

/**
 * Build a line whose one claim matches one changed path.
 * @param overrides - fields to replace.
 * @returns a line the fixture registry agrees with unless overridden.
 */
function patchLine(overrides: Partial<PatchLine> = {}): PatchLine {
  return {
    commits: [commit('aaaaaaaaaa', 'alpha-seam')],
    merges: [],
    changedPaths: ['alpha/a.md', REGISTRY_PATH],
    claims: [
      { slug: 'alpha-seam', pathspec: 'alpha/**', paths: ['alpha/a.md'] },
      { slug: 'alpha-seam', pathspec: REGISTRY_PATH, paths: [REGISTRY_PATH] },
    ],
    ...overrides,
  }
}

/**
 * Read what git itself says about a command that cannot run.
 * @param cwd - working directory for the command.
 * @param args - git arguments expected to fail.
 * @returns git's own first line of standard error.
 */
function gitStderrFirstLine(cwd: string, args: string[]): string {
  try {
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (cause) {
    const { stderr } = cause as { stderr?: string }
    const [first = ''] = (stderr ?? '').trim().split('\n')
    return first.trim()
  }
  throw new Error(`git ${args.join(' ')} was expected to fail`)
}

/**
 * Build a throwaway git repository whose HEAD sits on the declared patch line
 * above a root commit tagged as the declared base release, with the registry
 * and one claimed file written but not committed, so the halves of this check
 * that read git can be driven end to end.
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
  /**
   * Commit an upstream release on its own branch off a commit and tag it.
   * @param from - the commit the release descends from.
   * @param tag - the release tag name.
   * @param annotated - true for an annotated tag, false for a lightweight one.
   * @returns the release commit's full id.
   */
  function release(from: string, tag: string, annotated: boolean): string {
    git(['checkout', '--quiet', '-b', `upstream-${tag}`, from])
    write(`upstream/${tag}.md`, `${tag}\n`)
    const id = record(`upstream: ${tag}, with no trailer`)
    git(annotated ? ['tag', '-a', tag, '-m', tag] : ['tag', tag])
    git(['checkout', '--quiet', LINE])
    return id
  }
  git(['init', '--quiet', '--initial-branch', LINE])
  write('base.md', 'base\n')
  const base = record('root')
  git(['tag', BASE_TAG])
  write(REGISTRY_PATH, registry)
  write('alpha/a.md', 'alpha\n')
  return { root, git, write, record, release, base }
}

describe('parseRegistry', () => {
  it('reads both declarations, and each record\'s slug, title, status and pathspecs', () => {
    expect(parseRegistry(REGISTRY)).toEqual<Registry>({
      declaredLines: [LINE],
      declaredBaseTags: [BASE_TAG],
      malformedHeadings: [],
      unclosedFence: null,
      records: [
        { slug: 'alpha-seam', title: 'An alpha seam', status: '在役', pathspecs: ['alpha/**', REGISTRY_PATH] },
        { slug: 'beta-seat', title: 'A beta seat', status: '退役', pathspecs: null },
      ],
    })
  })

  it('reads a file written with CRLF or CR-only line endings', () => {
    expect(parseRegistry(REGISTRY.replace(/\n/gu, '\r\n'))).toEqual(parseRegistry(REGISTRY))
    expect(parseRegistry(REGISTRY.replace(/\n/gu, '\r'))).toEqual(parseRegistry(REGISTRY))
  })

  it('does not close a fence on a nested line that carries an info string', () => {
    const nested = REGISTRY.replace('不是补丁记录的小节不参与登记。', [
      '```', '```js', '## example-slug — 示例记录', '- **状态**：在役', '```',
    ].join('\n'))
    // CommonMark closes a fence only on a bare run of the same character, so
    // the ```js line is content and the record heading below it stays example.
    expect(parseRegistry(nested)).toEqual(parseRegistry(REGISTRY))
  })

  it('reports where a fence the file never closes was opened', () => {
    const unclosed = `${REGISTRY}\n\`\`\`md\n## example-slug — 示例记录\n`
    const parsed = parseRegistry(unclosed)
    expect(parsed.unclosedFence).toBe(unclosed.split('\n').indexOf('```md') + 1)
    expect(parsed.records.map(record => record.slug)).toEqual(['alpha-seam', 'beta-seat'])
  })

  it('reads nothing out of a fenced example', () => {
    const fenced = REGISTRY.replace('不是补丁记录的小节不参与登记。', [
      '```md',
      '**当前补丁线**：`core-patches-v1`',
      '**基座 tag**：`dsh-v0.0.1`',
      '## example-slug — 示例记录',
      '- **状态**：在役',
      '- **路径**：`example/**`',
      '```',
      '',
      '~~~',
      '## another-example — 另一个示例',
      '~~~',
    ].join('\n'))
    expect(parseRegistry(fenced)).toEqual(parseRegistry(REGISTRY))
  })

  it('collects a repeated declaration rather than keeping the first', () => {
    const repeated = REGISTRY.replace(`**基座 tag**：\`${BASE_TAG}\``, `**基座 tag**：\`${BASE_TAG}\`\n\n**基座 tag**：\`dsh-v0.0.1\``)
    expect(parseRegistry(repeated).declaredBaseTags).toEqual([BASE_TAG, 'dsh-v0.0.1'])
  })

  it('keeps the first status of a record and never carries one past a plain heading', () => {
    const source = [
      '## alpha-seam — An alpha seam', '- **状态**：在役', '- **状态**：退役', '## 身份规则', '- **状态**：在役', '- **路径**：`x`', '',
    ].join('\n')
    expect(parseRegistry(source).records).toEqual([
      { slug: 'alpha-seam', title: 'An alpha seam', status: '在役', pathspecs: null },
    ])
  })

  it('joins every 路径 line of a record, and reads one without a backquoted pathspec as empty', () => {
    const source = [
      '## alpha-seam — One', '- **状态**：在役', '- **路径**：`a/**` `b.md`', '- **路径**：`c.md`',
      '## gamma-row — Two', '- **状态**：在役', '- **路径**：none', '',
    ].join('\n')
    expect(parseRegistry(source).records.map(record => record.pathspecs)).toEqual([['a/**', 'b.md', 'c.md'], []])
  })

  it('reports a record that declares no status', () => {
    expect(parseRegistry('## alpha-seam — An alpha seam\n\nno status line\n').records)
      .toEqual([{ slug: 'alpha-seam', title: 'An alpha seam', status: null, pathspecs: null }])
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

  it('accepts a line whose commits name registered slugs and whose paths are all claimed', () => {
    expect(findRegistryViolations(patchLine(), registry)).toEqual([])
  })

  it('accepts a commit that names a retired slug', () => {
    expect(findRegistryViolations(patchLine({ commits: [commit('aaaaaaaaaa', 'beta-seat')] }), registry)).toEqual([])
  })

  it('rejects a changed path no standing record claims', () => {
    const violations = findRegistryViolations(patchLine({ changedPaths: ['alpha/a.md', REGISTRY_PATH, 'core/x.ts'] }), registry)
    expect(violations).toEqual([{
      kind: 'unclaimed-path',
      subject: 'core/x.ts',
      detail: `core/x.ts differs from the base tag, and no 在役 or 局部退役 record in ${REGISTRY_PATH} claims it in its 路径 line.`,
    }])
  })

  it('rejects a pathspec that matches nothing, and a standing record none of whose pathspecs match', () => {
    const one = findRegistryViolations(patchLine({
      changedPaths: [REGISTRY_PATH],
      claims: [
        { slug: 'alpha-seam', pathspec: 'alpha/**', paths: [] },
        { slug: 'alpha-seam', pathspec: REGISTRY_PATH, paths: [REGISTRY_PATH] },
      ],
    }), registry)
    expect(one.map(violation => [violation.kind, violation.subject])).toEqual([['unused-pathspec', 'alpha-seam']])
    expect(one[0]!.detail).toContain('`alpha/**`')

    const none = findRegistryViolations(patchLine({
      changedPaths: [],
      claims: [
        { slug: 'alpha-seam', pathspec: 'alpha/**', paths: [] },
        { slug: 'alpha-seam', pathspec: REGISTRY_PATH, paths: [] },
      ],
    }), registry)
    expect(none.map(violation => violation.kind)).toEqual(['unused-pathspec', 'unused-pathspec', 'unused-active-slug'])
    expect(none[2]!.detail).toContain('its status is 退役')
  })

  it('rejects a standing record without a 路径 line, partly retired included', () => {
    const partial = parseRegistry('## alpha-seam — One\n- **状态**：局部退役（core-patches-v10）\n')
    expect(findRegistryViolations(patchLine({ changedPaths: [], claims: [] }), partial)).toEqual([{
      kind: 'missing-paths',
      subject: 'alpha-seam',
      detail: `${REGISTRY_PATH} records alpha-seam as 局部退役 without a 路径 line naming at least one backquoted pathspec; a standing family claims the paths it changes against the base tag.`,
    }])
    const empty = parseRegistry('## alpha-seam — One\n- **状态**：在役\n- **路径**：none\n')
    expect(findRegistryViolations(patchLine({ changedPaths: [], claims: [] }), empty).map(violation => violation.kind)).toEqual(['missing-paths'])
  })

  it('rejects a retired record that carries a 路径 line', () => {
    const retired = parseRegistry(REGISTRY.replace('- **状态**：退役（上游 PR #1）', '- **状态**：退役（上游 PR #1）\n- **路径**：`beta/**`'))
    expect(findRegistryViolations(patchLine(), retired)).toEqual([{
      kind: 'retired-record-claims-paths',
      subject: 'beta-seat',
      detail: `${REGISTRY_PATH} records beta-seat as 退役 and still carries a 路径 line; a retired family claims no change, so any change it left behind must surface as unclaimed.`,
    }])
  })

  it('rejects a commit with no trailer and one with two', () => {
    const violations = findRegistryViolations(
      patchLine({ commits: [commit('aaaaaaaaaa'), commit('bbbbbbbbbb', 'alpha-seam', 'beta-seat')] }),
      registry,
    )
    expect(violations.map(violation => violation.kind)).toEqual(['trailer-count', 'trailer-count'])
    expect(violations[0]!.detail).toContain('carries 0 Patch trailers')
    expect(violations[1]!.detail).toContain('carries 2 Patch trailers')
  })

  it('rejects a trailer value that is not a slug', () => {
    // git takes any trailer value, including one folded across lines, which
    // unfolds to a value with a space in it.
    const violations = findRegistryViolations(
      patchLine({ commits: [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'alpha-seam continued')] }),
      registry,
    )
    expect(violations.map(violation => violation.kind)).toEqual(['malformed-trailer'])
    expect(violations[0]!.detail).toContain('is not a slug')
  })

  it('rejects a slug the registry does not register', () => {
    const violations = findRegistryViolations(
      patchLine({ commits: [commit('aaaaaaaaaa', 'alpha-seam'), commit('bbbbbbbbbb', 'gamma-row')] }),
      registry,
    )
    expect(violations).toEqual([{
      kind: 'unregistered-slug',
      subject: 'bbbbbbbbbb',
      detail: `bbbbbbbbbb (subject bbbbbbbbbb) names Patch: gamma-row, which ${REGISTRY_PATH} does not register.`,
    }])
  })

  it('accepts a release merge and a tree-preserving merge, and rejects any other merge', () => {
    const merges = [
      { id: 'cccccccccc', subject: 'release', mergesRelease: true, treeUnchanged: false },
      { id: 'dddddddddd', subject: 'join', mergesRelease: false, treeUnchanged: true },
      { id: 'eeeeeeeeee', subject: 'topic', mergesRelease: false, treeUnchanged: false },
    ]
    const violations = findRegistryViolations(patchLine({ merges }), registry)
    expect(violations.map(violation => [violation.kind, violation.subject])).toEqual([['merge-commit', 'eeeeeeeeee']])
  })

  it('rejects a duplicated slug and a record without a status', () => {
    const duplicated = parseRegistry([
      '## alpha-seam — One', '- **状态**：在役', '- **路径**：`alpha/**`', '',
      '## alpha-seam — Two', '- **状态**：退役', '',
      '## gamma-row — Three', '', 'no status', '',
    ].join('\n'))
    const violations = findRegistryViolations(patchLine({ changedPaths: ['alpha/a.md'], claims: [{ slug: 'alpha-seam', pathspec: 'alpha/**', paths: ['alpha/a.md'] }] }), duplicated)
    expect(violations.map(violation => violation.kind)).toEqual(['duplicate-slug', 'missing-status'])
  })

  it('reports a malformed heading before anything else', () => {
    const malformed = parseRegistry('## alpha-seam - One\n- **状态**：在役\n')
    expect(findRegistryViolations(patchLine({ commits: [], changedPaths: [], claims: [] }), malformed).map(violation => violation.kind)).toEqual(['malformed-heading'])
  })
})

describe('reading git', () => {
  it('resolves a lightweight and an annotated tag to their commits, and a missing one to null', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    const annotated = fixture.release(fixture.base, 'dsh-v1.1.0', true)
    expect(tagCommit(fixture.root, BASE_TAG)).toBe(fixture.base)
    expect(tagCommit(fixture.root, 'dsh-v1.1.0')).toBe(annotated)
    expect(tagCommit(fixture.root, 'dsh-v9.9.9')).toBeNull()
    expect(releaseCommits(fixture.root)).toEqual(new Set([fixture.base, annotated]))
  })

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

  it('walks the first-parent chain only, and classifies each merge on it', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'side'])
    fixture.write('side.md', 'side\n')
    fixture.record('side, with no trailer')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge side', 'side'])
    fixture.git(['checkout', '--quiet', '-b', 'joined', fixture.base])
    fixture.write('joined.md', 'joined\n')
    fixture.record('joined history, with no trailer')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-s', 'ours', '-m', 'join', 'joined'])

    expect(lineCommits(fixture.root, fixture.base).map(entry => entry.subject)).toEqual(['registry'])
    const merges = lineMerges(fixture.root, fixture.base, releaseCommits(fixture.root))
    expect(merges.map(merge => [merge.subject, merge.mergesRelease, merge.treeUnchanged])).toEqual([
      ['merge side', false, false],
      ['join', false, true],
    ])
    expect(merges[0]!.id).toHaveLength(10)
  })

  it('lists changed paths without the generated set, and matches a pathspec as a glob', (test) => {
    const fixture = repository(test)
    fixture.write('pnpm-lock.yaml', 'lock\n')
    fixture.write('docs/a.i18n.yaml', 'record\n')
    fixture.write('snapshots/web/case/ui.expected.md', 'expected\n')
    fixture.write('snapshots/web/case/session.v3.jsonl', '{}\n')
    fixture.write('alpha/deep/b.md', 'b\n')
    fixture.record('registry\n\nPatch: alpha-seam')

    expect(changedPaths(fixture.root, fixture.base, null).sort()).toEqual([
      REGISTRY_PATH, 'alpha/a.md', 'alpha/deep/b.md', 'snapshots/web/case/session.v3.jsonl',
    ])
    expect(changedPaths(fixture.root, fixture.base, 'alpha/**')).toEqual(['alpha/a.md', 'alpha/deep/b.md'])
    expect(changedPaths(fixture.root, fixture.base, 'alpha/*.md')).toEqual(['alpha/a.md'])
    expect(changedPaths(fixture.root, fixture.base, 'snapshots/**/ui.expected.md')).toEqual([])
  })
})

describe('runCheck', () => {
  it('agrees when every commit names a registered slug and every changed path is claimed', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root)).toEqual({
      status: 'ok',
      report: `1 commit(s), 0 merge(s), 2 changed path(s) and 2 registry record(s) agree against ${BASE_TAG}.`,
    })
  })

  it('agrees when an unclaimed path is a generator output', (test) => {
    const fixture = repository(test)
    fixture.write('pnpm-lock.yaml', 'lock\n')
    fixture.write('packages/extensions/tool-cordis/src/api-catalog.ts', 'export {}\n')
    fixture.write('snapshots/web/case/ui.expected.md', 'expected\n')
    fixture.write('apps/web/tests/expected/case.md', 'expected\n')
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root).status).toBe('ok')
  })

  it('rejects a changed path no record claims', (test) => {
    const fixture = repository(test)
    fixture.write('core/x.ts', 'export {}\n')
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('unclaimed-path: core/x.ts differs')
  })

  it('rejects a snapshot input fixture no record claims', (test) => {
    const fixture = repository(test)
    fixture.write('snapshots/web/case/session.v3.jsonl', '{}\n')
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root).report).toContain('unclaimed-path: snapshots/web/case/session.v3.jsonl')
  })

  it('rejects a pathspec and a standing record that match nothing', (test) => {
    const fixture = repository(test, REGISTRY.replace('`alpha/**` ', '`alpha/**` `gone/**` '))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('unused-pathspec: ')
    expect(result.report).toContain('`gone/**`')

    const retiredChange = repository(test, REGISTRY.replace(`\`alpha/**\` \`${REGISTRY_PATH}\``, '`alpha/**`').replace('- **状态**：退役（上游 PR #1）', '- **状态**：在役\n- **路径**：`.claude/**`'))
    rmSync(join(retiredChange.root, 'alpha'), { recursive: true })
    retiredChange.record('registry\n\nPatch: beta-seat')
    expect(runCheck(retiredChange.root).report).toContain('unused-active-slug: ')
  })

  it('rejects a standing record without a 路径 line and a retired record with one', (test) => {
    const fixture = repository(test, REGISTRY.replace(`- **路径**：\`alpha/**\` \`${REGISTRY_PATH}\``, '').replace('- **状态**：退役（上游 PR #1）', `- **状态**：退役（上游 PR #1）\n- **路径**：\`alpha/**\` \`${REGISTRY_PATH}\``))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('missing-paths: ')
    expect(result.report).toContain('retired-record-claims-paths: ')
    // The retired record's pathspecs claim nothing, so its paths surface too.
    expect(result.report).toContain('unclaimed-path: alpha/a.md')
  })

  it('agrees when a retired family\'s commits stay on the line but its change is gone', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.write('beta/b.md', 'beta\n')
    fixture.record('beta work\n\nPatch: beta-seat')
    rmSync(join(fixture.root, 'beta'), { recursive: true })
    fixture.record('retire beta\n\nPatch: beta-seat')
    expect(runCheck(fixture.root).status).toBe('ok')
  })

  it('rejects a first-parent commit with no trailer, and one with two', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam\n\nprose after the trailer block')
    fixture.record('two\n\nPatch: alpha-seam\nPatch: beta-seat')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('carries 0 Patch trailers')
    expect(result.report).toContain('carries 2 Patch trailers')
  })

  it('rejects a trailer value git accepts and the slug format does not, in one line of report', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('folded value\n\nPatch: alpha-seam\n  continued')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('malformed-trailer: ')
    expect(result.report).toContain('Patch: alpha-seam continued')
    expect(result.report.split('\n')).toHaveLength(2)
  })

  it('rejects a slug the registry does not register', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.record('unknown\n\nPatch: gamma-row')
    expect(runCheck(fixture.root).report).toContain('unregistered-slug: ')
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

  it('rejects a topic merge whose second parent is outside every release', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'side', fixture.base])
    fixture.write('alpha/side.md', 'side\n')
    fixture.record('side\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge side\n\nPatch: alpha-seam', 'side'])

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('merge-commit:')
  })

  it('rejects a topic branch cut from a line that has merged the declared tag', (test) => {
    // The declared tag is an ancestor of the topic's tip, so a rule that only
    // asked for that ancestry would pass the untrailed commit under the merge.
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'topic'])
    fixture.write('alpha/topic.md', 'topic\n')
    fixture.record('topic change, with no trailer')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge topic\n\nPatch: alpha-seam', 'topic'])

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report.split('\n').filter(line => line.includes('merge-commit:'))).toHaveLength(1)
    expect(result.report).not.toContain('trailer-count')
  })

  it('rejects a merge whose second parent is a tag outside the release pattern', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.release(fixture.base, 'desktop-v1.0.0', false)
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge desktop', 'desktop-v1.0.0'])
    fixture.write(REGISTRY_PATH, REGISTRY.replace('`alpha/**` ', '`alpha/**` `upstream/**` '))
    fixture.record('claim\n\nPatch: alpha-seam')

    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('merge-commit:')
  })

  it('agrees with an -s ours join whose second parent carries no trailer', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'joined', fixture.base])
    fixture.write('joined.md', 'joined\n')
    fixture.record('joined history, with no trailer')
    fixture.git(['checkout', '--quiet', LINE])
    fixture.git(['merge', '--quiet', '--no-ff', '-s', 'ours', '-m', 'join', 'joined'])

    expect(runCheck(fixture.root)).toMatchObject({ status: 'ok', report: expect.stringContaining('1 merge(s)') as string })
  })

  for (const annotated of [false, true]) {
    it(`agrees with a merge of ${annotated ? 'an annotated' : 'a lightweight'} release tag once the registry declares it`, (test) => {
      const fixture = repository(test)
      fixture.record('registry\n\nPatch: alpha-seam')
      fixture.release(fixture.base, 'dsh-v1.1.0', annotated)
      fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge dsh-v1.1.0', 'dsh-v1.1.0'])
      // Still declaring the older tag, the release's own change is unclaimed.
      expect(runCheck(fixture.root).report).toContain('unclaimed-path: upstream/dsh-v1.1.0.md')

      fixture.write(REGISTRY_PATH, registryFor('dsh-v1.1.0'))
      fixture.record('declare dsh-v1.1.0\n\nPatch: alpha-seam')
      expect(runCheck(fixture.root)).toEqual({
        status: 'ok',
        report: '2 commit(s), 1 merge(s), 2 changed path(s) and 2 registry record(s) agree against dsh-v1.1.0.',
      })
    })
  }

  it('agrees after merging two releases in turn, the older merge still on the first-parent chain', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    const first = fixture.release(fixture.base, 'dsh-v1.1.0', false)
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge dsh-v1.1.0', 'dsh-v1.1.0'])
    fixture.write(REGISTRY_PATH, registryFor('dsh-v1.1.0'))
    fixture.record('declare dsh-v1.1.0\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root).status).toBe('ok')

    fixture.release(first, 'dsh-v1.2.0', false)
    fixture.git(['merge', '--quiet', '--no-ff', '-m', 'merge dsh-v1.2.0', 'dsh-v1.2.0'])
    fixture.write(REGISTRY_PATH, registryFor('dsh-v1.2.0'))
    fixture.record('declare dsh-v1.2.0\n\nPatch: alpha-seam')
    // The dsh-v1.1.0 merge is no ancestor of dsh-v1.2.0, so it stays in range
    // with a second parent older than the declared tag.
    expect(runCheck(fixture.root)).toEqual({
      status: 'ok',
      report: '3 commit(s), 2 merge(s), 2 changed path(s) and 2 registry record(s) agree against dsh-v1.2.0.',
    })
  })

  it('reports a declared base tag the repository does not have', (test) => {
    const fixture = repository(test, registryFor('dsh-v9.9.9'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('base-tag-missing: ')
    expect(result.report).toContain('git fetch upstream --tags')
  })

  it('reports a declared base tag HEAD has not merged', (test) => {
    const fixture = repository(test, registryFor('dsh-v1.1.0'))
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.release(fixture.base, 'dsh-v1.1.0', false)
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('base-tag-not-merged: ')
  })

  it('skips a checkout that is not on the declared line, unclaimed changes included', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    fixture.git(['checkout', '--quiet', '-b', 'develop'])
    fixture.write('apps/desktop/main.ts', 'export {}\n')
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

  it('skips a shallow clone, whose history cannot reach the declared tag', (test) => {
    const fixture = repository(test)
    fixture.record('registry\n\nPatch: alpha-seam')
    const clone = join(mkdtempSync(join(tmpdir(), 'dsh-core-patches-clone-')), 'shallow')
    test.onTestFinished(() => {
      rmSync(dirname(clone), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    })
    fixture.git(['clone', '--quiet', '--depth', '1', `file://${fixture.root}`, clone])

    expect(isShallowClone(clone)).toBe(true)
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

  it('reports a registry that declares no base tag, and one that declares two', (test) => {
    const fixture = repository(test, REGISTRY.split('\n').filter(line => !line.startsWith('**基座 tag**')).join('\n'))
    fixture.record('registry\n\nPatch: alpha-seam')
    const none = runCheck(fixture.root)
    expect(none.status).toBe('failed')
    expect(none.report).toContain('declares 基座 tag 0 time(s)')

    fixture.write(REGISTRY_PATH, REGISTRY.replace(`**基座 tag**：\`${BASE_TAG}\``, `**基座 tag**：\`${BASE_TAG}\`\n\n**基座 tag**：\`dsh-v0.0.1\``))
    const two = runCheck(fixture.root)
    expect(two.status).toBe('failed')
    expect(two.report).toContain('declares 基座 tag 2 time(s)')
  })

  it('reads the declarations through a fenced example without taking the example\'s', (test) => {
    const fenced = REGISTRY.replace('不是补丁记录的小节不参与登记。', [
      '```md', '**当前补丁线**：`core-patches-v1`', '**基座 tag**：`dsh-v0.0.1`', '## example-slug — 示例记录', '```',
    ].join('\n'))
    const fixture = repository(test, fenced)
    fixture.record('registry\n\nPatch: alpha-seam')
    expect(runCheck(fixture.root).status).toBe('ok')
  })

  it('reports a registry whose code fence is never closed', (test) => {
    const fixture = repository(test, `${REGISTRY}\n\`\`\`md\n## example-slug — 示例记录\n`)
    fixture.record('registry\n\nPatch: alpha-seam')
    const result = runCheck(fixture.root)
    expect(result.status).toBe('failed')
    expect(result.report).toContain('code fence opened at line')
  })

  it('reports a failed git command in one line, with git\'s own reason', (test) => {
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
    // `Command failed: <the command again>` is what the thrown message leads
    // with; git says why on standard error, in whatever language it is set to.
    expect(result.report).not.toContain('Command failed')
    expect(result.report).toContain(gitStderrFirstLine(plain, ['branch', '--show-current']))
  })
})
