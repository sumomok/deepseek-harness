/**
 * Two-process relocation e2e child: mounts the built backend over the given
 * root, lists its sessions (the backend's first operation recovers
 * relocation intents a dead process left), optionally relocates one session,
 * and prints the listed and relocated cwds as one JSON line. Runs the built
 * package under plain Node.
 */

import { Context } from '@deepseek-ai/cordis'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const [root, compression, id, cwd] = process.argv.slice(2)
const ctx = new Context()
await ctx.plugin(JsonlSessionPersistence, { root, compression })
const listed = (await ctx.sessionPersistence.list()).map(row => ({ id: row.header.id, cwd: row.header.cwd ?? null }))
const relocated = id === undefined ? null : (await ctx.sessionPersistence.relocate(id, cwd)).header.cwd
process.stdout.write(`${JSON.stringify({ listed, relocated })}\n`)
await ctx.fiber.dispose()
