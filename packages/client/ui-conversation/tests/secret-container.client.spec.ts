// @vitest-environment jsdom
// The pre-send secret-container confirmation's zero-content-reading match:
// the fixed base heuristic (full matrix), path segments as a desktop-only
// signal, and the config's append-only shape (extra patterns can only add
// matches, never remove or replace a base one).

import { describe, expect, it } from 'vitest'
import { matchSecretContainerFiles, secretContainerCandidate } from '../src/client/secret-container.ts'
import type { SecretContainerCandidate } from '../src/client/secret-container.ts'

/** Assert exactly one candidate hit-tests true and the rest false, independent of matrix ordering. */
function expectHit(name: string, path?: string): void {
  const hit = matchSecretContainerFiles([{ name, ...(path === undefined ? {} : { path }) }])
  expect(hit, `expected a hit for ${name}${path === undefined ? '' : ` @ ${path}`}`).toHaveLength(1)
}

function expectNoHit(name: string, path?: string): void {
  const hit = matchSecretContainerFiles([{ name, ...(path === undefined ? {} : { path }) }])
  expect(hit, `expected no hit for ${name}${path === undefined ? '' : ` @ ${path}`}`).toHaveLength(0)
}

describe('matchSecretContainerFiles: base name matrix', () => {
  it('matches .env and .env.* variants, case-insensitively', () => {
    expectHit('.env')
    expectHit('.env.local')
    expectHit('.env.production')
    expectHit('.ENV.LOCAL')
    expectNoHit('environment.txt')
    expectNoHit('myenv.local')
  })

  it('matches SSH private-key base names case-insensitively, excluding the .pub counterpart', () => {
    expectHit('id_rsa')
    expectHit('ID_RSA')
    expectHit('id_ed25519')
    expectHit('id_ecdsa')
    expectHit('id_rsa.old')
    expectNoHit('id_rsa.pub')
    expectNoHit('ID_RSA.PUB')
    expectNoHit('id_rsa_backup_notes.txt')
  })

  it('matches *.pem and *.key suffixes case-insensitively', () => {
    expectHit('server.pem')
    expectHit('SERVER.PEM')
    expectHit('private.key')
    expectNoHit('keyboard.txt')
  })

  it('matches credentials* and secrets.* prefixes', () => {
    expectHit('credentials')
    expectHit('credentials.json')
    expectHit('CREDENTIALS.YAML')
    expectHit('secrets.yaml')
    expectHit('secrets.json')
    expectNoHit('my-secrets-notes.txt') // "secrets." prefix, not a substring
  })

  it('matches .netrc, .npmrc, .pypirc exactly', () => {
    expectHit('.netrc')
    expectHit('.npmrc')
    expectHit('.pypirc')
    expectNoHit('netrc.txt')
  })

  it('matches *.keychain, *.p12, *.pfx suffixes', () => {
    expectHit('login.keychain')
    expectHit('cert.p12')
    expectHit('cert.pfx')
  })

  it('leaves an ordinary text file unmatched', () => {
    expectNoHit('notes.txt')
    expectNoHit('report.pdf')
    expectNoHit('image.png')
  })
})

describe('matchSecretContainerFiles: path segments (desktop only)', () => {
  it('matches a fixed directory segment only when a path is supplied', () => {
    expectHit('id_rsa_backup', '/Users/x/.ssh/id_rsa_backup')
    expectHit('config', 'C:\\Users\\x\\.aws\\config')
    expectHit('creds', '/home/x/.gnupg/creds')
    expectHit('kubeconfig', '/home/x/.kube/kubeconfig')
    expectHit('config.json', '/home/x/.docker/config.json')
    // The same filename with no path (web: the File API carries none) is not matched.
    expectNoHit('id_rsa_backup')
  })

  it('does not match an unrelated directory segment', () => {
    expectNoHit('notes.txt', '/Users/x/Documents/notes.txt')
  })
})

describe('matchSecretContainerFiles: order and multi-file batches', () => {
  it('preserves input order and returns only the matching subset', () => {
    const files = [
      { name: 'readme.md' },
      { name: '.env' },
      { name: 'photo.png' },
      { name: 'id_rsa' },
    ]
    expect(matchSecretContainerFiles(files).map(f => f.name)).toEqual(['.env', 'id_rsa'])
  })
})

describe('matchSecretContainerFiles: append-only extra patterns', () => {
  it('adds a match for a deployment-appended substring absent from the base list', () => {
    expectNoHit('company-internal-config.yaml')
    expect(matchSecretContainerFiles(
      [{ name: 'company-internal-config.yaml' }],
      ['company-internal'],
    )).toHaveLength(1)
  })

  it('matches the appended substring case-insensitively, as a substring anywhere in the name', () => {
    expect(matchSecretContainerFiles([{ name: 'MY-Token-Store.dat' }], ['token-store'])).toHaveLength(1)
  })

  it('never removes or narrows a base-list hit, however extra patterns are populated', () => {
    // An unrelated, an empty, and an unmatched-anyway extra pattern must all
    // leave the base hit intact — the merge is pure addition, with no shape
    // able to express "exclude this base match".
    for (const extra of [[], [''], ['zzz-unrelated'], ['.env']]) {
      expect(matchSecretContainerFiles([{ name: '.env' }], extra)).toHaveLength(1)
    }
  })

  it('adds nothing when extra patterns are absent (default parameter)', () => {
    expect(matchSecretContainerFiles([{ name: 'plain.txt' }])).toHaveLength(0)
  })
})

describe('secretContainerCandidate', () => {
  it('reads name and the Electron-only desktop path extension when present', () => {
    const withPath = new File(['x'], 'id_rsa') as File & { path?: string }
    withPath.path = '/Users/x/.ssh/id_rsa'
    const candidate: SecretContainerCandidate = secretContainerCandidate(withPath)
    expect(candidate).toEqual({ name: 'id_rsa', path: '/Users/x/.ssh/id_rsa' })
  })

  it('omits path when the browser File carries none (web)', () => {
    const webFile = new File(['x'], 'id_rsa')
    expect(secretContainerCandidate(webFile)).toEqual({ name: 'id_rsa' })
  })

  it('ignores a non-string .path value defensively', () => {
    const oddFile = new File(['x'], 'id_rsa') as File & { path?: unknown }
    oddFile.path = 123
    expect(secretContainerCandidate(oddFile)).toEqual({ name: 'id_rsa' })
  })
})
