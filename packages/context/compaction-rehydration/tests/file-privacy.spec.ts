/**
 * Files privacy boundary: only a path inside the Session's working directory
 * and outside known credential locations may be restated; everything else is
 * omitted without naming it.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { Session as SessionObject } from '@deepseek-ai/dsh-session'
import { fileSection } from '../src/file-section.ts'
import { readWindowDigest } from '../src/read-registry.ts'
import type { ReadFsLike } from '../src/read-registry.ts'

const SECRET = 'TOPSECRET_TOKEN'

interface FakeFile {
  text: string
  version: string
  type?: string
}

class FakeFs implements ReadFsLike {
  readonly files = new Map<string, FakeFile>()
  unreadable = new Set<string>()

  add(path: string, file: FakeFile): void {
    this.files.set(path, file)
  }

  async resolve(path: string): Promise<object> {
    return { key: path }
  }

  async stat(target: object): Promise<{ version: string; type: string } | undefined> {
    const file = this.files.get(keyOf(target))
    if (file === undefined) return undefined
    return { version: file.version, type: file.type ?? 'file' }
  }

  async readText(target: object): Promise<string> {
    const path = keyOf(target)
    if (this.unreadable.has(path)) throw new Error('denied')
    const file = this.files.get(path)
    if (file === undefined) throw new Error('missing')
    return file.text
  }

  contains(parent: object, child: object): boolean {
    const workspace = keyOf(parent)
    const path = keyOf(child)
    return path === workspace || path.startsWith(`${workspace}/`)
  }
}

function keyOf(target: object): string {
  return (target as { key?: string }).key ?? ''
}

/** A Session whose header carries (or omits) a working directory. */
function sessionWith(cwd: string | undefined): SessionObject {
  const id = SessionId(`files-privacy-${String(Math.random())}`)
  return Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: Date.now(),
    ...cwd === undefined ? {} : { cwd },
    isSeeded: false,
  })
}

/** Record one full read exactly as the read tool persists it. */
function recordRead(session: SessionObject, path: string, text: string): void {
  const callId = ToolCallId(`call-${path}`)
  const lines = text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
  session.append('tool/call', {
    turn: 1,
    step: 1,
    callId,
    name: 'read',
    arguments: JSON.stringify({ file_path: path, offset: 1 }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'read result' }],
      isError: false,
    }),
    meta: {
      path,
      offset: 1,
      lines,
      totalLines: lines.length,
      version: 'v1',
      size: Buffer.byteLength(text, 'utf8'),
      read: 'full',
      digest: readWindowDigest(lines),
    },
  }, { surfaceOp: 'append' })
}

/** One read whose current file is `current` at `version`. */
async function sectionFor(path: string, options: { cwd?: string; current?: string; version?: string }): Promise<string | undefined> {
  const session = sessionWith(options.cwd)
  recordRead(session, path, 'old content')
  const fs = new FakeFs()
  fs.add(path, { text: options.current ?? SECRET, version: options.version ?? 'v2' })
  const ctx = new Context()
  ctx.provide('fs', fs)
  return (await fileSection(session, ctx))?.text
}

describe('the Files privacy boundary', () => {
  it.each([
    '/home/user/.npmrc',
    '/home/user/.netrc',
    '/home/user/.git-credentials',
    '/home/user/secrets/api_key.txt',
    '/home/user/.config/gcloud/application_default_credentials.json',
    '/home/user/.ssh/id_rsa',
    '/home/user/.aws/credentials',
    '/home/user/.env.local',
    '/home/user/project/credentials/db.txt',
  ])('omits a changed credential-like path inside the workspace: %s', async (path) => {
    const text = await sectionFor(path, { cwd: '/home/user' })
    expect(text ?? '').not.toContain(path)
    expect(text ?? '').not.toContain(SECRET)
  })

  it('omits a credential-like path even when the read is unchanged', async () => {
    const path = '/home/user/secrets/api_key.txt'
    const text = await sectionFor(path, { cwd: '/home/user', current: 'one\ntwo', version: 'v1' })
    expect(text ?? '').not.toContain(path)
    expect(text ?? '').not.toContain('one')
  })

  it('omits a read outside the working directory without naming it', async () => {
    const text = await sectionFor('/home/user/notes.md', { cwd: '/workspace' })
    expect(text).toBeUndefined()
  })

  it('omits every file when the Session has no working directory', async () => {
    const text = await sectionFor('/workspace/src/app.ts', {})
    expect(text).toBeUndefined()
  })

  it('does not treat a sibling directory with the workspace prefix as inside', async () => {
    const text = await sectionFor('/workspace-other/notes.md', { cwd: '/workspace' })
    expect(text).toBeUndefined()
  })

  it('restates a normal workspace file as current content', async () => {
    const path = '/workspace/src/app.ts'
    const text = await sectionFor(path, { cwd: '/workspace', current: 'export const value = 1', version: 'v2' })
    expect(text).toContain(`### \`${path}\``)
    expect(text).toContain('export const value = 1')
  })

  it('keeps an unchanged normal workspace file to one line without content', async () => {
    const path = '/workspace/src/app.ts'
    const text = await sectionFor(path, { cwd: '/workspace', current: 'one\ntwo', version: 'v1' })
    expect(text).toContain(`\`${path}\` — unchanged since your read`)
    expect(text).not.toContain('```text')
  })

  it('omits a path that cannot be resolved rather than guessing its workspace', async () => {
    const session = sessionWith('/workspace')
    recordRead(session, '/workspace/src/app.ts', 'old')
    const fs = new FakeFs()
    fs.resolve = async (path: string) => {
      if (path === '/workspace') return { key: path }
      throw new Error('unresolvable')
    }
    const ctx = new Context()
    ctx.provide('fs', fs)
    expect(await fileSection(session, ctx)).toBeUndefined()
  })
})
