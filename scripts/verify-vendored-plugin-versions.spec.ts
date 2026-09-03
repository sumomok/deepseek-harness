import { describe, expect, it } from 'vitest'
import {
  type BuiltInPluginDocument,
  findVendoredPluginViolations,
  parseBuiltInPluginTable,
  parseOverrideRepositoryPaths,
  parseVendoredPlugins,
  type VendoredPluginSources,
} from './verify-vendored-plugin-versions.ts'

const manifest = JSON.stringify({
  dependencies: {
    '@deepseek-ai/dsh': 'workspace:^',
    '@haoran/dsh-clickable-refs': 'file:./vendor/haoran-dsh-clickable-refs-0.4.1.tgz',
    'dsh-better-sidebar': 'file:./vendor/dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz',
  },
})

const EN_PROVENANCE = ', from a tarball committed in this repository'
const ZH_PROVENANCE = ',来自提交进本仓库的 tarball'

function englishReadme(rows: string[], subsection: string[] = []): string {
  return [
    '# desktop',
    '',
    '## Built-in plugins',
    '',
    '| Package | Version | What it adds |',
    '|---|---|---|',
    ...rows,
    '',
    ...subsection.length === 0 ? [] : ['### Withdrawn', '', ...subsection, ''],
    '## Limitations',
    '',
    '| `@haoran/dsh-clickable-refs` | `9.9.9` | a row past the section |',
    '',
  ].join('\n')
}

const EN_ROWS = [
  `| \`dsh-better-sidebar\` | \`0.18.0-alpha.0-patched1\`${EN_PROVENANCE} | A sidebar |`,
  `| \`@haoran/dsh-clickable-refs\` | \`0.4.1\`${EN_PROVENANCE} | Clickable paths |`,
]

const ZH_ROWS = [
  `| \`dsh-better-sidebar\` | \`0.18.0-alpha.0-patched1\`${ZH_PROVENANCE} | 侧栏 |`,
  `| \`@haoran/dsh-clickable-refs\` | \`0.4.1\`${ZH_PROVENANCE} | 可点击路径 |`,
]

function chineseReadme(rows: string[]): string {
  return ['# 桌面端', '', '## 内置插件', '', '| 包名 | 版本 | 提供什么 |', '|---|---|---|', ...rows, ''].join('\n')
}

function documents(en = EN_ROWS, zh = ZH_ROWS, subsection: string[] = []): BuiltInPluginDocument[] {
  return [
    { path: 'apps/desktop/README.md', heading: '## Built-in plugins', provenance: EN_PROVENANCE, text: englishReadme(en, subsection) },
    { path: 'apps/desktop/README.zh.md', heading: '## 内置插件', provenance: ZH_PROVENANCE, text: chineseReadme(zh) },
  ]
}

const overrides = {
  'oxlint': { license: 'MIT', repo: 'https://github.com/oxc-project/oxc' },
  '@haoran/dsh-clickable-refs': { repo: 'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz' },
}

const present = new Set([
  'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz',
  'apps/desktop-server/vendor/dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz',
])

function sources(overlay: Partial<VendoredPluginSources> = {}): VendoredPluginSources {
  return { manifest, documents: documents(), overrides, exists: path => present.has(path), ...overlay }
}

describe('parseVendoredPlugins', () => {
  it('derives each version from its tarball filename and skips workspace dependencies', () => {
    expect(parseVendoredPlugins(manifest)).toEqual({
      plugins: [
        { name: '@haoran/dsh-clickable-refs', version: '0.4.1', tarball: 'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz' },
        { name: 'dsh-better-sidebar', version: '0.18.0-alpha.0-patched1', tarball: 'apps/desktop-server/vendor/dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz' },
      ],
      violations: [],
    })
  })

  it('reports a file: specifier that does not name a tarball under ./vendor/', () => {
    expect(parseVendoredPlugins(JSON.stringify({ dependencies: { 'dsh-at-file': 'file:../elsewhere/dsh-at-file-0.7.0.tgz' } }))).toEqual({
      plugins: [],
      violations: ['apps/desktop-server/package.json declares dsh-at-file as file:../elsewhere/dsh-at-file-0.7.0.tgz; a built-in must be a tarball under ./vendor/.'],
    })
  })

  it('reports a specifier whose filename does not carry its package name', () => {
    expect(parseVendoredPlugins(JSON.stringify({ dependencies: { '@haoran/dsh-screenshot': 'file:./vendor/screenshot-0.5.0.tgz' } })).violations).toEqual([
      'apps/desktop-server/package.json declares @haoran/dsh-screenshot as screenshot-0.5.0.tgz, which does not start with haoran-dsh-screenshot-; no version can be derived from it.',
    ])
  })
})

describe('parseBuiltInPluginTable', () => {
  it('reads the whole section, stopping only at the next h2', () => {
    const [english] = documents()
    expect([...parseBuiltInPluginTable(english!).rows]).toEqual([
      ['dsh-better-sidebar', { cell: `\`0.18.0-alpha.0-patched1\`${EN_PROVENANCE}`, version: '0.18.0-alpha.0-patched1' }],
      ['@haoran/dsh-clickable-refs', { cell: `\`0.4.1\`${EN_PROVENANCE}`, version: '0.4.1' }],
    ])
  })

  it('reports a package listed twice', () => {
    const [english] = documents([...EN_ROWS, EN_ROWS[1]!])
    expect(parseBuiltInPluginTable(english!).violations).toEqual([
      'apps/desktop/README.md lists @haoran/dsh-clickable-refs in the built-in plugins table more than once.',
    ])
  })

  it('returns nothing when the section is absent', () => {
    const document: BuiltInPluginDocument = { path: 'x.md', heading: '## Built-in plugins', provenance: EN_PROVENANCE, text: '# desktop\n\n## Something else\n' }
    expect(parseBuiltInPluginTable(document).rows.size).toBe(0)
  })
})

describe('parseOverrideRepositoryPaths', () => {
  it('keeps every entry whose repo has no URL scheme, and strips a leading ./', () => {
    expect([...parseOverrideRepositoryPaths({
      ...overrides,
      'a': { repo: './apps/desktop-server/vendor/a-1.0.0.tgz' },
      'b': { repo: 'apps/desktop-servers/vendor/b-1.0.0.tgz' },
      'c': { repo: 'apps/desktop-server/vendor/c-1.0.0.tar.gz' },
      'd': { repo: 'git+ssh://git@github.com/x/y.git' },
    })]).toEqual([
      ['@haoran/dsh-clickable-refs', 'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz'],
      ['a', 'apps/desktop-server/vendor/a-1.0.0.tgz'],
      ['b', 'apps/desktop-servers/vendor/b-1.0.0.tgz'],
      ['c', 'apps/desktop-server/vendor/c-1.0.0.tar.gz'],
    ])
  })
})

describe('findVendoredPluginViolations', () => {
  it('accepts references that agree with the committed tarballs', () => {
    expect(findVendoredPluginViolations(sources())).toEqual([])
  })

  it('rejects a row left at the previous version in either language', () => {
    expect(findVendoredPluginViolations(sources({ documents: documents(EN_ROWS.map(row => row.replace('`0.4.1`', '`0.3.3`'))) }))).toEqual([
      'apps/desktop/README.md lists @haoran/dsh-clickable-refs as 0.3.3; apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz carries 0.4.1.',
    ])
    expect(findVendoredPluginViolations(sources({ documents: documents(EN_ROWS, ZH_ROWS.map(row => row.replace('`0.4.1`', '`0.3.3`'))) }))).toEqual([
      'apps/desktop/README.zh.md lists @haoran/dsh-clickable-refs as 0.3.3; apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz carries 0.4.1.',
    ])
  })

  it('rejects a version cell whose provenance no longer says the tarball is committed here', () => {
    const en = EN_ROWS.map(row => row.replace(`\`0.18.0-alpha.0-patched1\`${EN_PROVENANCE}`, '`0.18.0-alpha.0-patched1`, from npm'))
    expect(findVendoredPluginViolations(sources({ documents: documents(en) }))).toEqual([
      'apps/desktop/README.md row for dsh-better-sidebar reads "`0.18.0-alpha.0-patched1`, from npm"; its version cell must read "`0.18.0-alpha.0-patched1`, from a tarball committed in this repository".',
    ])
  })

  it('rejects a version cell with no code span', () => {
    const en = EN_ROWS.map(row => row.replace(`\`0.4.1\`${EN_PROVENANCE}`, 'the latest one'))
    expect(findVendoredPluginViolations(sources({ documents: documents(en) }))).toEqual([
      'apps/desktop/README.md row for @haoran/dsh-clickable-refs has no version code span; its version cell reads "the latest one".',
    ])
  })

  it('rejects a missing row in either language', () => {
    expect(findVendoredPluginViolations(sources({ documents: documents([EN_ROWS[1]!]) }))).toEqual([
      'apps/desktop/README.md lists no built-in plugins row for dsh-better-sidebar.',
    ])
    expect(findVendoredPluginViolations(sources({ documents: documents(EN_ROWS, [ZH_ROWS[1]!]) }))).toEqual([
      'apps/desktop/README.zh.md lists no built-in plugins row for dsh-better-sidebar.',
    ])
  })

  it('rejects a row for a plugin the manifest no longer vendors', () => {
    const orphan = `| \`@sumomok/dsh-edit-rerun\` | \`0.1.0\`${EN_PROVENANCE} | A withdrawn built-in |`
    expect(findVendoredPluginViolations(sources({ documents: documents([...EN_ROWS, orphan]) }))).toEqual([
      'apps/desktop/README.md has a built-in plugins row for @sumomok/dsh-edit-rerun, which apps/desktop-server/package.json does not declare as a vendored tarball.',
    ])
  })

  it('rejects a row under a subsection of the same section', () => {
    const orphan = `| \`@sumomok/dsh-edit-rerun\` | \`0.1.0\`${EN_PROVENANCE} | A withdrawn built-in |`
    expect(findVendoredPluginViolations(sources({ documents: documents(EN_ROWS, ZH_ROWS, [orphan]) }))).toEqual([
      'apps/desktop/README.md has a built-in plugins row for @sumomok/dsh-edit-rerun, which apps/desktop-server/package.json does not declare as a vendored tarball.',
    ])
  })

  it('rejects an override path a near-miss directory, prefix, or extension would have hidden', () => {
    const nearMisses = {
      'directory typo': { repo: 'apps/desktop-servers/vendor/haoran-dsh-clickable-refs-0.4.1.tgz' },
      'leading dot slash': { repo: './apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.0.tgz' },
      'wrong extension': { repo: 'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tar.gz' },
    }
    expect(findVendoredPluginViolations(sources({ overrides: nearMisses }))).toEqual([
      'gen-third-party-notices OVERRIDES points directory typo at apps/desktop-servers/vendor/haoran-dsh-clickable-refs-0.4.1.tgz, which does not exist.',
      'gen-third-party-notices OVERRIDES points leading dot slash at apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.0.tgz, which does not exist.',
      'gen-third-party-notices OVERRIDES points wrong extension at apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tar.gz, which does not exist.',
    ])
  })

  it('leaves an override naming a URL alone', () => {
    expect(findVendoredPluginViolations(sources({ overrides: { 'dsh-at-file': { repo: 'https://github.com/omdsh-dev/dsh-at-file' } } }))).toEqual([])
  })

  it('rejects an OVERRIDES entry pointing at a tarball that is not committed', () => {
    const stale = { '@haoran/dsh-clickable-refs': { repo: 'apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.0.tgz' } }
    expect(findVendoredPluginViolations(sources({ overrides: stale }))).toEqual([
      'gen-third-party-notices OVERRIDES points @haoran/dsh-clickable-refs at apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.0.tgz, which does not exist.',
    ])
  })

  it('rejects a manifest specifier whose tarball was never committed', () => {
    expect(findVendoredPluginViolations(sources({ exists: () => false }))).toEqual([
      'apps/desktop-server/package.json declares @haoran/dsh-clickable-refs as apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz, which does not exist.',
      'apps/desktop-server/package.json declares dsh-better-sidebar as apps/desktop-server/vendor/dsh-better-sidebar-0.18.0-alpha.0-patched1.tgz, which does not exist.',
      'gen-third-party-notices OVERRIDES points @haoran/dsh-clickable-refs at apps/desktop-server/vendor/haoran-dsh-clickable-refs-0.4.1.tgz, which does not exist.',
    ])
  })

  it('rejects an empty vendored set and an unreadable table', () => {
    const empty = documents().map(document => ({ ...document, text: '# desktop\n' }))
    expect(findVendoredPluginViolations(sources({ manifest: '{}', documents: empty, overrides: {} }))).toEqual([
      'apps/desktop-server/package.json declares no file: vendor dependency; the built-in plugin set cannot be empty.',
      'apps/desktop/README.md has no readable built-in plugins table; its "## Built-in plugins" section or table format changed.',
      'apps/desktop/README.zh.md has no readable built-in plugins table; its "## 内置插件" section or table format changed.',
    ])
  })
})
