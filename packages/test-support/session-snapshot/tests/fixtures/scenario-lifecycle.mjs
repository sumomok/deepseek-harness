import assert from 'node:assert/strict'
import { test } from 'node:test'
import { apply as applyWaitFixture } from '../../../../../snapshots/sdk/background-wait-steer/wait-fixture.mjs'
import { apply as applyVersionFixture } from '../../../../../snapshots/file-version-fixture.mjs'

function waitFixture() {
  const hooks = new Map()
  const subscribers = new Set()
  let status = 'running'
  let killFailure
  const agent = {
    id: 'owner',
    steer() {},
    session: { deriveMessages: () => [{ role: 'user', content: 'STEER_WHILE_WAITING' }] },
    inbox: { nextStep: [{ id: 'notice', source: { kind: 'tool-jobs' }, content: 'finished' }], remove() {} },
  }
  applyWaitFixture({
    on(name, listener) { hooks.set(name, listener) },
    jobs: {
      get: () => ({ status }),
      readAt: () => ({ chunks: [{ channel: 'stdout', text: 'producer ready\n' }] }),
      events: { subscribe(_filter, listener) { subscribers.add(listener); return () => subscribers.delete(listener) } },
      kill() {
        if (killFailure) throw killFailure
        if (status !== 'running') return 'already-finished'
        status = 'killed'
        for (const listener of subscribers) listener({ type: 'settled', job: { id: 'job' }, awaited: false })
        return 'requested'
      },
    },
  })
  const exec = { name: 'job_output', agent, arguments: { job_id: 'job' }, signal: new AbortController().signal }
  return {
    async ready() {
      await hooks.get('tools/pre-execute')(exec, () => {})
      hooks.get('tools/result')(exec, { content: [{ type: 'text', text: 'producer ready\n[status: running]' }] })
    },
    finish: () => hooks.get('agent/turn-stopping')({ agent }),
    complete: () => { status = 'completed' },
    failKill: () => { killFailure = new Error('kill failed') },
    subscriptions: () => subscribers.size,
  }
}

test('already-finished producer reports the original failure and releases the subscription', { timeout: 10_000 }, async () => {
  const run = waitFixture()
  await run.ready()
  run.complete()
  await assert.rejects(run.finish(), /producer stopped before the steered step/)
  assert.equal(run.subscriptions(), 0)
})

test('running producer settles before cleanup returns', async () => {
  const run = waitFixture()
  await run.ready()
  await run.finish()
  assert.equal(run.subscriptions(), 0)
})

test('failed kill releases the subscription', async () => {
  const run = waitFixture()
  await run.ready()
  run.failKill()
  await assert.rejects(run.finish(), /kill failed/)
  assert.equal(run.subscriptions(), 0)
})

test('file version fixture preserves repeated and changed identities and restores its provider', async () => {
  let rawVersion = '1:2:3:4:5'
  const original = async target => target.targetKey === 'missing' ? undefined : { version: rawVersion, type: 'file', size: 3 }
  const fs = { resolve: async path => ({ targetKey: path }), stat: original }
  let dispose
  await applyVersionFixture({ fs, effect(setup) { dispose = setup() } }, { paths: ['task.txt'] })
  try {
    const target = await fs.resolve('task.txt')
    assert.equal((await fs.stat(target)).version, 'snapshot-file:task.txt:1')
    assert.equal((await fs.stat(target)).version, 'snapshot-file:task.txt:1')
    rawVersion = '1:2:3:6:7'
    assert.equal((await fs.stat(target)).version, 'snapshot-file:task.txt:2')
    assert.equal((await fs.stat(await fs.resolve('other.txt'))).version, rawVersion)
    assert.equal(await fs.stat(await fs.resolve('missing')), undefined)
  } finally {
    dispose()
  }
  assert.equal(fs.stat, original)
})

test('file version fixture forwards current and stale guards to the real version check', async () => {
  const target = { targetKey: 'task.txt' }
  let version = 'raw-1'
  const received = []
  const fs = {
    resolve: async () => target,
    stat: async () => ({ version, type: 'file' }),
    writeText: async (_target, content, guard) => {
      received.push(guard.version)
      if (guard.version !== version) throw new Error('FS_STALE_VERSION')
      version = 'raw-3'
      return { version, operation: 'update', before: 'old', after: content }
    },
  }
  const originalWrite = fs.writeText
  let dispose
  await applyVersionFixture({ fs, effect(setup) { dispose = setup() } }, { paths: ['task.txt'] })
  try {
    const before = await fs.stat(target)
    version = 'raw-2'
    await assert.rejects(fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: before.version }), /FS_STALE_VERSION/)
    const current = await fs.stat(target)
    const result = await fs.writeText(target, 'new', { kind: 'replaceIfVersion', version: current.version })
    assert.deepEqual(received, ['raw-1', 'raw-2'])
    assert.equal(result.version, 'snapshot-file:task.txt:3')
    assert.equal((await fs.stat(target)).version, result.version)
  } finally {
    dispose()
  }
  assert.equal(fs.writeText, originalWrite)
})
