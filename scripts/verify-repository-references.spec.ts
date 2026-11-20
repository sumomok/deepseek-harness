import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, type TestContext } from 'vitest'
import { CORE_PATCHES_HISTORY_PATH } from './core-patches-history.ts'
import { CORE_PATCHES_UPSTREAM_MERGES_PATH } from './core-patches-upstream-merges.ts'
import { findRepositoryReferences, repositoryCommits, scanRepositoryReferences, uniquePrefixMatch } from './verify-repository-references.ts'

const organizationUrl = `https://${['github.com', ['deepseek', 'harness'].join('-')].join('/')}`

function repository(test: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-repository-references-'))
  test.onTestFinished(() => {
    rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })
  function git(args: string[], input?: string): string {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Repository reference test',
        GIT_AUTHOR_EMAIL: 'repository-reference@example.invalid',
        GIT_COMMITTER_NAME: 'Repository reference test',
        GIT_COMMITTER_EMAIL: 'repository-reference@example.invalid',
      },
      ...(input === undefined ? {} : { input }),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
  }
  function write(file: string, source: string): void {
    const path = join(root, file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
  }
  git(['init', '--quiet'])
  write('tracked.md', 'release tags\n')
  git(['add', 'tracked.md'])
  const tree = git(['write-tree'])
  const commit = git(['commit-tree', tree, '-m', 'fixture'])
  git(['update-ref', 'HEAD', commit])
  return { root, git, write, commit, tree }
}

/** Two commit object bodies whose object names share at least `length` leading hexadecimal digits. */
function collidingCommitBodies(tree: string, length: number): [string, string] {
  const algorithm = tree.length === 64 ? 'sha256' : 'sha1'
  const seen = new Map<string, string>()
  for (let index = 0; ; index += 1) {
    const body = `tree ${tree}\nauthor T <t@example.invalid> 0 +0000\ncommitter T <t@example.invalid> 0 +0000\n\ncollision ${String(index)}\n`
    const prefix = createHash(algorithm).update(`commit ${String(Buffer.byteLength(body))}\0${body}`).digest('hex').slice(0, length)
    if (!/[a-f]/.test(prefix)) continue
    const previous = seen.get(prefix)
    if (previous !== undefined) return [previous, body]
    seen.set(prefix, body)
  }
}

describe('unique object-name prefix search', () => {
  it.each([
    [['aaa1', 'bbb2', 'ccc3'], 'bbb', 'bbb2'],
    [['abc1', 'abc2'], 'abc', undefined],
    [['a1', 'b2'], 'b', 'b2'],
    [['abc', 'abd'], 'abc', 'abc'],
    [['abc'], 'abd', undefined],
    [['abc'], 'abcd', undefined],
    [[], 'abc', undefined],
  ] as const)('finds in %j the one name starting with %s', (objects, prefix, expected) => {
    expect(uniquePrefixMatch(objects, prefix)).toBe(expected)
  })
})

describe('historical manifest reference tokens', () => {
  function manifest(hash: string, reason = 'Approved', subject = 'Historical subject'): string {
    return JSON.stringify({ version: 1, cutoff: hash, entries: [{ commit: hash, subject, patch: 'alpha-seam', reason }] }, null, 2)
  }

  it.for(['compact', 'multiline', 'crlf', 'escaped', 'reordered'] as const)('exempts only identity value tokens in %s JSON', (mode, test) => {
    const fixture = repository(test)
    let source = manifest(fixture.commit)
    if (mode === 'compact') source = JSON.stringify(JSON.parse(source))
    if (mode === 'crlf') source = source.replaceAll('\n', '\r\n')
    if (mode === 'escaped') source = source.replaceAll(fixture.commit, fixture.commit.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')).replace('cutoff', String.raw`cut\u006fff`)
    if (mode === 'reordered') source = JSON.stringify({ entries: [{ reason: 'Approved', patch: 'alpha-seam', subject: 'Historical subject', commit: fixture.commit }], cutoff: fixture.commit, version: 1 })
    fixture.write(CORE_PATCHES_HISTORY_PATH, source)
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it.for(['reason', 'subject'] as const)('checks identical hashes in %s even on the same line as exempt values', (field, test) => {
    const fixture = repository(test)
    const hash = fixture.commit
    const source = manifest(hash, field === 'reason' ? hash : 'Approved', field === 'subject' ? hash : 'Historical subject')
    fixture.write(CORE_PATCHES_HISTORY_PATH, JSON.stringify(JSON.parse(source)))
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: CORE_PATCHES_HISTORY_PATH, line: 1, kind: 'commit-hash' }])
    fixture.write(CORE_PATCHES_HISTORY_PATH, source)
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: CORE_PATCHES_HISTORY_PATH, line: source.split('\n').findIndex(line => line.includes(`"${field}"`)) + 1, kind: 'commit-hash' }])
  })

  it('checks decoded prose hashes when every occurrence uses JSON Unicode escapes', (test) => {
    const fixture = repository(test)
    const source = manifest(fixture.commit, fixture.commit).replaceAll(fixture.commit, fixture.commit.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''))
    fixture.write(CORE_PATCHES_HISTORY_PATH, source)
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: CORE_PATCHES_HISTORY_PATH, line: 9, kind: 'commit-hash' }])
  })

  it.for(['other.json', 'nested/.claude/core-patches-history.json', '.claude/core-patches-history.json.bak'])('does not exempt the same manifest at %s', (file, test) => {
    const fixture = repository(test)
    fixture.write(file, JSON.stringify(JSON.parse(manifest(fixture.commit))))
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file, line: 1, kind: 'commit-hash' }])
  })

  it.for(['invalid-json', 'unknown-field', 'wrong-version', 'wrong-type', 'empty-entries', 'duplicate-commit', 'duplicate-root-key', 'duplicate-entry-key', 'escaped-duplicate-key', 'uppercase', 'abbreviated'] as const)(
    'grants no exemptions to %s', (kind, test) => {
      const fixture = repository(test)
      const hash = fixture.commit
      let source = JSON.stringify(JSON.parse(manifest(hash)))
      if (kind === 'invalid-json') source += ','
      if (kind === 'unknown-field') source = source.replace('"version":1', `"extra":"${hash}","version":1`)
      if (kind === 'wrong-version') source = source.replace('"version":1', '"version":2')
      if (kind === 'wrong-type') source = source.replace('"version":1', '"version":"1"')
      if (kind === 'empty-entries') source = JSON.stringify({ version: 1, cutoff: hash, entries: [] })
      if (kind === 'duplicate-commit') source = JSON.stringify({ version: 1, cutoff: hash, entries: [1, 2].map(() => ({ commit: hash, subject: 'Historical subject', patch: 'alpha-seam', reason: 'Approved' })) })
      if (kind === 'duplicate-root-key') source = source.replace('"version":1', '"version":1,"version":1')
      if (kind === 'duplicate-entry-key') source = source.replace('"reason":', '"reason":"Approved","reason":')
      if (kind === 'escaped-duplicate-key') source = source.replace('"reason":', String.raw`"r\u0065ason":"Approved","reason":`)
      if (kind === 'uppercase') source = source.replaceAll(hash, hash.toUpperCase())
      if (kind === 'abbreviated') source = source.replaceAll(hash, hash.slice(0, Math.max(10, hash.search(/[a-f]/) + 1)))
      fixture.write(CORE_PATCHES_HISTORY_PATH, source)
      expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: CORE_PATCHES_HISTORY_PATH, line: 1, kind: 'commit-hash' }])
    },
  )

  it('retains organization URL findings in an otherwise valid manifest', (test) => {
    const fixture = repository(test)
    fixture.write(CORE_PATCHES_HISTORY_PATH, manifest(fixture.commit, organizationUrl))
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: CORE_PATCHES_HISTORY_PATH, line: 9, kind: 'organization-url' }])
  })
})

describe('historical upstream merge reference tokens', () => {
  function manifest(hash: string, reason = 'Approved'): string {
    return JSON.stringify({
      version: 1,
      cutoff: hash,
      entries: [{ commit: hash, firstParent: hash, upstream: hash, reason }],
    }, null, 2)
  }

  function escapeAll(value: string): string {
    return value.split('').map(character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`).join('')
  }

  it.for(['compact', 'multiline', 'crlf', 'escaped', 'reordered'] as const)(
    'exempts only schema-defined identity tokens in %s JSON', (mode, test) => {
      const fixture = repository(test)
      const hash = fixture.commit
      let source = manifest(hash)
      if (mode === 'compact') source = JSON.stringify({ version: 1, cutoff: hash, entries: [{ commit: hash, firstParent: hash, upstream: hash, reason: 'Approved' }] })
      if (mode === 'crlf') source = source.replaceAll('\n', '\r\n')
      if (mode === 'escaped') source = source.replaceAll(hash, escapeAll(hash)).replace('firstParent', String.raw`first\u0050arent`)
      if (mode === 'reordered') source = JSON.stringify({ entries: [{ reason: 'Approved', upstream: hash, firstParent: hash, commit: hash }], cutoff: hash, version: 1 })
      fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, source)
      expect(scanRepositoryReferences(fixture.root)).toEqual([])
    },
  )

  it('checks hashes in reason on the same line, multiline, and Unicode-escaped', (test) => {
    const fixture = repository(test)
    const hash = fixture.commit
    const entry = { commit: hash, firstParent: hash, upstream: hash, reason: hash }
    fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, JSON.stringify({ version: 1, cutoff: hash, entries: [entry] }))
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: CORE_PATCHES_UPSTREAM_MERGES_PATH, line: 1, kind: 'commit-hash' },
    ])
    const pretty = manifest(hash, hash)
    fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, pretty)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: CORE_PATCHES_UPSTREAM_MERGES_PATH, line: pretty.split('\n').findIndex(line => line.includes('"reason"')) + 1, kind: 'commit-hash' },
    ])
    fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, pretty.replaceAll(hash, escapeAll(hash)))
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: CORE_PATCHES_UPSTREAM_MERGES_PATH, line: pretty.split('\n').findIndex(line => line.includes('"reason"')) + 1, kind: 'commit-hash' },
    ])
  })

  it.for([
    'other.json',
    'nested/.claude/core-patches-upstream-merges.json',
    '.claude/core-patches-upstream-merges.json.bak',
  ])('does not exempt the same upstream-merge manifest at %s', (file, test) => {
    const fixture = repository(test)
    fixture.write(file, JSON.stringify({
      version: 1,
      cutoff: fixture.commit,
      entries: [{ commit: fixture.commit, firstParent: fixture.commit, upstream: fixture.commit, reason: 'Approved' }],
    }))
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file, line: 1, kind: 'commit-hash' }])
  })

  it.for([
    'invalid-json',
    'unknown-field',
    'wrong-version',
    'empty-entries',
    'multiple-entries',
    'duplicate-key',
    'escaped-duplicate-key',
    'uppercase',
    'abbreviated',
  ] as const)('grants no exemptions to %s', (kind, test) => {
    const fixture = repository(test)
    const hash = fixture.commit
    const entry = { commit: hash, firstParent: hash, upstream: hash, reason: 'Approved' }
    let source = JSON.stringify({ version: 1, cutoff: hash, entries: [entry] })
    if (kind === 'invalid-json') source += ','
    if (kind === 'unknown-field') source = source.replace('"version":1', `"extra":"${hash}","version":1`)
    if (kind === 'wrong-version') source = source.replace('"version":1', '"version":2')
    if (kind === 'empty-entries') source = JSON.stringify({ version: 1, cutoff: hash, entries: [] })
    if (kind === 'multiple-entries') source = JSON.stringify({ version: 1, cutoff: hash, entries: [entry, entry] })
    if (kind === 'duplicate-key') source = source.replace('"reason":', '"reason":"Approved","reason":')
    if (kind === 'escaped-duplicate-key') source = source.replace('"reason":', String.raw`"r\u0065ason":"Approved","reason":`)
    if (kind === 'uppercase') source = source.replaceAll(hash, hash.toUpperCase())
    if (kind === 'abbreviated') source = source.replaceAll(hash, hash.slice(0, Math.max(10, hash.search(/[a-f]/) + 1)))
    fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, source)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: CORE_PATCHES_UPSTREAM_MERGES_PATH, line: 1, kind: 'commit-hash' },
    ])
  })

  it('retains organization URL findings in an otherwise valid upstream-merge manifest', (test) => {
    const fixture = repository(test)
    const source = manifest(fixture.commit, organizationUrl)
    fixture.write(CORE_PATCHES_UPSTREAM_MERGES_PATH, source)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: CORE_PATCHES_UPSTREAM_MERGES_PATH, line: source.split('\n').findIndex(line => line.includes('"reason"')) + 1, kind: 'organization-url' },
    ])
  })
})

describe('maintained repository reference policy', () => {
  const numericCommit = String(6_344_383)

  it.each([
    ['uv.lock', `artifact = { size = ${numericCommit} }`],
    ['python/sdk/uv.lock', `sdist.size = ${numericCommit}`],
    ['fixture.json', `{"context_length": ${numericCommit}}`],
    ['package.json', `{"version": "1.0.${numericCommit}"}`],
    ['config.toml', `rev = "${numericCommit}"`],
    ['notes.md', `commit ${numericCommit}\nhttps://example.invalid/commit/${numericCommit}`],
    ['source.ts', `// commit ${numericCommit}`],
  ])('accepts decimal-only tokens in %s even when they name a commit', (file, source) => {
    expect(findRepositoryReferences(file, source, new Set([numericCommit]))).toEqual([])
  })

  it.each([7, 12, 40])('accepts a decimal-only %i-character token beside a hexadecimal commit', (length) => {
    const decimal = '1'.repeat(length)
    const hexadecimal = `${'1'.repeat(length - 1)}a`
    expect(findRepositoryReferences('source.md', `${decimal} ${hexadecimal}`, new Set([decimal, hexadecimal]))).toEqual([
      { file: 'source.md', line: 1, kind: 'commit-hash' },
    ])
    expect(findRepositoryReferences('source.md', decimal, new Set([decimal]))).toEqual([])
  })

  it.each([
    ['python/sdk/dependencies.toml', 'revision = "HASH"', 1],
    ['fixture.json', '{"revision": "HASH"}', 1],
    ['notes.md', 'release\ncommit HASH', 2],
    ['source.ts', '// commit HASH', 1],
  ] as const)('rejects commit tokens containing a hex letter in %s', (file, template, line) => {
    const hash = `${numericCommit}a`
    expect(findRepositoryReferences(file, template.replace('HASH', hash), new Set([hash]))).toEqual([
      { file, line, kind: 'commit-hash' },
    ])
  })

  it('excludes the real generated lockfile, including reference-shaped generated content', () => {
    const file = 'python/sdk/uv.lock'
    const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8').trimEnd()
    const sizes = new Set([...source.matchAll(/\bsize\s*=\s*(\d+)/g)].map(match => match[1] ?? ''))
    expect(sizes.size).toBeGreaterThan(0)
    expect(sizes).not.toContain('')
    expect(findRepositoryReferences(file, source, sizes)).toEqual([])
    const hash = `${numericCommit}a`
    expect(findRepositoryReferences(file, `${source}\n# commit ${hash}\n# ${organizationUrl}`, new Set([...sizes, hash]))).toEqual([])
  })

  it('excludes a real numeric commit prefix from both candidate resolution and file findings', (test) => {
    const fixture = repository(test)
    const algorithm = fixture.tree.length === 64 ? 'sha256' : 'sha1'
    for (let index = 0; ; index += 1) {
      const body = `tree ${fixture.tree}\nauthor T <t@example.invalid> 0 +0000\ncommitter T <t@example.invalid> 0 +0000\n\nnumeric ${String(index)}\n`
      const commit = createHash(algorithm).update(`commit ${String(Buffer.byteLength(body))}\0${body}`).digest('hex')
      if (!/^\d{7}/.test(commit) || !/[a-f]/.test(commit.slice(0, 40))) continue
      fixture.git(['hash-object', '-t', 'commit', '-w', '--stdin'], body)
      const decimal = commit.slice(0, 7)
      const hexadecimal = commit.slice(0, Math.max(8, commit.search(/[a-f]/) + 1))
      const source = `commit ${decimal}\ncommit ${hexadecimal}`
      expect(repositoryCommits(fixture.root, [source])).toEqual(new Set([hexadecimal]))
      fixture.write('references.md', source)
      expect(scanRepositoryReferences(fixture.root)).toEqual([
        { file: 'references.md', line: 2, kind: 'commit-hash' },
      ])
      return
    }
  })

  it.each(['\n', '\r\n', '\r'])('exempts only the registry base commit token with %j line endings', (ending) => {
    const hash = 'ab'.repeat(20)
    const declaration = `**基座 commit**：\`${hash}\``
    const file = '.claude/core-patches.md'
    const source = ['# Registry', declaration, `prose ${hash}`, `${declaration} beside ${hash}`, `${declaration} ${hash.slice(0, 12)}`]
    // Each valid registry has exactly one declaration; nearby tokens remain ordinary references.
    expect(findRepositoryReferences(file, source.slice(0, 3).join(ending), new Set([hash]))).toEqual([
      { file, line: 3, kind: 'commit-hash' },
    ])
    for (const line of source.slice(3)) {
      expect(findRepositoryReferences(file, line, new Set([hash, hash.slice(0, 12)]))).toEqual([
        { file, line: 1, kind: 'commit-hash' },
      ])
    }
    expect(findRepositoryReferences(file, declaration, new Set([hash]))).toEqual([])
  })

  it.each([
    ['docs/base.md', 'DECLARATION'],
    ['nested/.claude/core-patches.md', 'DECLARATION'],
    ['.claude/core-patches.md', 'prose DECLARATION'],
    ['.claude/core-patches.md', '**基座 tag**：`HASH`'],
    ['.claude/core-patches.md', '**基座 commit**：`HASH^0`'],
    ['.claude/core-patches.md', '```md\nDECLARATION\n```'],
    ['.claude/core-patches.md', '~~~md\nDECLARATION\n~~~'],
    ['.claude/core-patches.md', '   ````md\n```\nDECLARATION\n````'],
    ['.claude/core-patches.md', '```md\n```js\nDECLARATION\n```'],
    ['.claude/core-patches.md', '~~~md\n```\nDECLARATION\n~~~'],
    ['.claude/core-patches.md', 'DECLARATION\n```'],
    ['.claude/core-patches.md', '**基座 tag**：`dsh-v1.0.0`\nDECLARATION'],
  ])('rejects a known hash outside the exact exemption in %s: %j', (file, template) => {
    const hash = 'ab'.repeat(20)
    const declaration = `**基座 commit**：\`${hash}\``
    const source = template.replace('DECLARATION', declaration).replace('HASH', hash)
    expect(findRepositoryReferences(file, source, new Set([hash]))).toEqual([
      { file, line: source.split('\n').findIndex(line => line.includes(hash)) + 1, kind: 'commit-hash' },
    ])
  })

  it.each(['ab'.repeat(6), 'AB'.repeat(20)])('rejects abbreviated or uppercase base declarations: %s', (hash) => {
    expect(findRepositoryReferences('.claude/core-patches.md', `**基座 commit**：\`${hash}\``, new Set([hash.toLowerCase()]))).toEqual([
      { file: '.claude/core-patches.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it('exempts a declaration after a matching longer fence closes, while rejecting the fenced hash', () => {
    const hash = 'ab'.repeat(20)
    const declaration = `**基座 commit**：\`${hash}\``
    const source = ['   ~~~md', declaration, '   ~~~~', declaration].join('\n')
    expect(findRepositoryReferences('.claude/core-patches.md', source, new Set([hash]))).toEqual([
      { file: '.claude/core-patches.md', line: 2, kind: 'commit-hash' },
    ])
  })

  it('rejects both tokens when the registry duplicates its base declaration', () => {
    const hash = 'ab'.repeat(20)
    const declaration = `**基座 commit**：\`${hash}\``
    expect(findRepositoryReferences('.claude/core-patches.md', `${declaration}\n${declaration}`, new Set([hash]))).toEqual([
      { file: '.claude/core-patches.md', line: 1, kind: 'commit-hash' },
      { file: '.claude/core-patches.md', line: 2, kind: 'commit-hash' },
    ])
  })

  it('keeps organization checks on the exempt declaration line', () => {
    const hash = 'ab'.repeat(20)
    expect(findRepositoryReferences('.claude/core-patches.md', `**基座 commit**：\`${hash}\` ${organizationUrl}`, new Set([hash]))).toEqual([
      { file: '.claude/core-patches.md', line: 1, kind: 'organization-url' },
    ])
  })

  it('exempts the real registry declaration during a repository scan, keeping identical prose references', (test) => {
    const fixture = repository(test)
    const declaration = `**基座 commit**：\`${fixture.commit}\``
    fixture.write('.claude/core-patches.md', `${declaration}\nprose ${fixture.commit}`)
    fixture.write('other.md', declaration)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: '.claude/core-patches.md', line: 2, kind: 'commit-hash' },
      { file: 'other.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it('permits only the independent kit repository and its source URLs', () => {
    for (const suffix of ['', '.git', '/tree/main/packages/entry']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toEqual([])
    }
    for (const suffix of ['-other', '.example', 's']) {
      expect(findRepositoryReferences('package.json', `${organizationUrl}/libreoffice-kit${suffix}`, new Set())).toHaveLength(1)
    }
  })

  it('rejects complete and abbreviated commit identifiers in tracked, staged, and new files', (test) => {
    const fixture = repository(test)
    fixture.write('tracked.md', `release\n${fixture.commit}\n${fixture.commit.toUpperCase()}\n`)
    const firstLetterEnd = fixture.commit.search(/[a-f]/) + 1
    fixture.write('staged.md', fixture.commit.slice(0, Math.max(7, firstLetterEnd)))
    fixture.git(['add', 'staged.md'])
    fixture.write('new.md', `\0${fixture.commit.slice(0, Math.max(12, firstLetterEnd))}`)

    expect(scanRepositoryReferences(fixture.root)).toEqual(expect.arrayContaining([
      { file: 'tracked.md', line: 2, kind: 'commit-hash' },
      { file: 'tracked.md', line: 3, kind: 'commit-hash' },
      { file: 'staged.md', line: 1, kind: 'commit-hash' },
      { file: 'new.md', line: 1, kind: 'commit-hash' },
    ]))
    expect(scanRepositoryReferences(fixture.root)).toHaveLength(4)
  })

  it('checks available unreachable commits without requiring a branch or network', (test) => {
    const fixture = repository(test)
    const unreachable = fixture.git(['commit-tree', fixture.tree, '-m', 'unreachable fixture'])
    fixture.write('unreachable.md', unreachable)
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'unreachable.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it('skips generated dependency lock files but still checks maintained text', () => {
    const hash = 'ab'.repeat(20)
    const source = `revision = "${hash}"\n# ${organizationUrl}`
    const commits = new Set([hash])
    for (const file of ['python/sdk/uv.lock', 'pnpm-lock.yaml', 'nested/dir/uv.lock']) {
      expect(findRepositoryReferences(file, source, commits)).toEqual([])
    }
    expect(findRepositoryReferences('docs/notes.md', source, commits)).toEqual([
      { file: 'docs/notes.md', line: 1, kind: 'commit-hash' },
      { file: 'docs/notes.md', line: 2, kind: 'organization-url' },
    ])
  })

  it('does not fetch missing commits from a partial clone\'s promisor remote', (test) => {
    const remote = repository(test)
    remote.git(['config', 'uploadpack.allowFilter', 'true'])
    const clone = join(remote.root, 'partial-clone')
    remote.git(['clone', '--filter=blob:none', '--no-local', remote.root, clone])
    const missing = remote.git(['commit-tree', remote.tree, '-p', remote.commit, '-m', 'remote-only fixture'])
    remote.git(['update-ref', 'HEAD', missing])
    remote.write('partial-clone/new.md', missing)

    expect(scanRepositoryReferences(clone)).toEqual([])
    expect(execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, GIT_NO_LAZY_FETCH: '1' },
      input: `${missing}\n`,
    }).trim()).toBe(`${missing} missing`)
  })

  it('accepts blobs, trees, unknown hex, long digests, and identifiers embedded in alphanumeric words', (test) => {
    const fixture = repository(test)
    const blob = fixture.git(['hash-object', '-w', '--stdin'], 'blob fixture')
    fixture.write('accepted.md', [
      blob,
      fixture.tree,
      '0'.repeat(40),
      `${fixture.commit}${'0'.repeat(24)}`,
      fixture.commit.slice(0, 6),
      `prefix${fixture.commit}`,
      `${fixture.commit}suffix`,
      'dsh-v0.0.1-rc.1',
    ].join('\n'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('accepts a prefix that two available commits share and rejects a longer unique prefix', (test) => {
    const fixture = repository(test)
    const [first, second] = collidingCommitBodies(fixture.tree, 7).map(body =>
      fixture.git(['hash-object', '-t', 'commit', '-w', '--stdin'], body))
    if (first === undefined || second === undefined) throw new Error('fixture must write two commits')
    let shared = 0
    while (first[shared] === second[shared]) shared += 1
    expect(shared).toBeGreaterThanOrEqual(7)
    fixture.write('ambiguous.md', first.slice(0, 7))
    fixture.write('unique.md', first.slice(0, shared + 1))
    expect(scanRepositoryReferences(fixture.root)).toEqual([{ file: 'unique.md', line: 1, kind: 'commit-hash' }])
  })

  it('accepts hexadecimal branch names that do not match the referenced commit identifier', (test) => {
    const fixture = repository(test)
    const branch = 'b'.repeat(12)
    fixture.git(['update-ref', `refs/heads/${branch}`, fixture.commit])
    fixture.write('branch.md', branch)
    expect(scanRepositoryReferences(fixture.root)).toEqual([])
  })

  it('excludes only ignored new files, vendored sources, frozen notes, and deleted files', (test) => {
    const fixture = repository(test)
    fixture.write('.gitignore', 'ignored.md\ntracked-ignore.md\n')
    fixture.write('ignored.md', fixture.commit)
    fixture.write('vendor/project/file.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('.agents/notes/archived/process/frozen.md', `${fixture.commit}\n${organizationUrl}`)
    fixture.write('tracked-ignore.md', fixture.commit)
    fixture.git(['add', '--force', 'tracked-ignore.md'])
    unlinkSync(join(fixture.root, 'tracked.md'))

    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'tracked-ignore.md', line: 1, kind: 'commit-hash' },
    ])
  })

  it.skipIf(process.platform === 'win32')('inspects dangling symlink targets without following files outside the tree', (test) => {
    const fixture = repository(test)
    symlinkSync(`../${fixture.commit}`, join(fixture.root, 'reference-link'))
    symlinkSync('../outside', join(fixture.root, 'ordinary-link'))
    expect(scanRepositoryReferences(fixture.root)).toEqual([
      { file: 'reference-link', line: 1, kind: 'commit-hash' },
    ])
  })

  it('rejects literal, encoded, escaped, case-varied, and compatibility forms of the organization URL', () => {
    const fullwidth = organizationUrl.split('').map(character =>
      String.fromCodePoint(character.charCodeAt(0) + 0xfee0)).join('')
    const source = [
      organizationUrl,
      `${organizationUrl.toUpperCase()}/project`,
      organizationUrl.replaceAll('/', '\\/'),
      organizationUrl.replaceAll('/', String.raw`\u002f`),
      organizationUrl.replaceAll('/', String.raw`\x2f`),
      organizationUrl.replaceAll('/', '%2F').replace('github', '%67ithub'),
      organizationUrl.replaceAll('/', '&#47;'),
      organizationUrl.replaceAll('/', '&#x2f;'),
      organizationUrl.replaceAll('/', '&sol;').replaceAll('-', '&hyphen;'),
      fullwidth,
      `${organizationUrl}?tab=repositories`,
    ].join('\n')
    expect(findRepositoryReferences('source.md', source, new Set())).toEqual(
      source.split('\n').map((_line, index) => ({ file: 'source.md', line: index + 1, kind: 'organization-url' })),
    )
  })

  it('accepts distinct organization names and excludes the frozen and vendored paths', () => {
    expect(findRepositoryReferences('source.md', `${organizationUrl}-tools/project`, new Set())).toEqual([])
    expect(findRepositoryReferences('vendor/project/source.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/archived/process/frozen.md', organizationUrl, new Set())).toEqual([])
    expect(findRepositoryReferences('.agents/notes/implemented/process/current.md', organizationUrl, new Set()))
      .toEqual([{ file: '.agents/notes/implemented/process/current.md', line: 1, kind: 'organization-url' }])
  })
})
