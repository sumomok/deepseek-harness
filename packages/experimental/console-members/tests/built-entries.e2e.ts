/**
 * Built-artifact guard for the directory state the package root and
 * `./credential-access` share. Both read a directory's state through one
 * module-created symbol; source-mode tests load that module once, so they
 * cannot expose a build that gives each entry its own copy. This test loads
 * the built entries by package name in a plain Node subprocess, mounts the row
 * through the root entry, attaches a reader through `ctx.consoleMembers`, and
 * requires `./credential-access` to read that reader and the registry.
 */

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const builtEntries = ['lib/index.js', 'lib/credential-access.js'].map(entry => join(packageRoot, entry))
const execFileAsync = promisify(execFile)

const builtProbe = String.raw`
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import * as row from "@deepseek-ai/dsh-experimental-console-members";
import { customerCredentialAccess, memberRegistryAccess } from "@deepseek-ai/dsh-experimental-console-members/credential-access";

const { publicKey } = generateKeyPairSync("ed25519");
const membersRoot = join(process.env.PROBE_BASE, "members");
const directory = randomUUID();
mkdirSync(join(membersRoot, directory), { recursive: true });
mkdirSync(join(process.env.DSH_HOME, "console-members"), { recursive: true });
const memberRoot = realpathSync.native(join(membersRoot, directory));
writeFileSync(join(process.env.DSH_HOME, "console-members", "roots.json"), JSON.stringify({
  version: 1,
  roots: [{ kind: "member", path: memberRoot, principal: "member-b", directory }],
}));
const ctx = new Context();
ctx.provide("connection", { peers: { requireAdmitter: true, admitWith: () => () => undefined } });
ctx.provide("workspaceRegistry", {});
const fiber = ctx.plugin(row, {
  assertionPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  deploymentId: "built-entries",
  membersRoot,
});
await fiber.await();
const release = ctx.consoleMembers.attachCustomerCredentials({
  read: (principal) => principal === "member-a" ? "token-a" : undefined,
  onChange: () => () => undefined,
});
const access = customerCredentialAccess(ctx.consoleMembers);
const answer = { read: access.read("member-a"), principals: memberRegistryAccess(ctx.consoleMembers).principals() };
release();
answer.afterRelease = access.read("member-a") ?? null;
await ctx.fiber.dispose();
process.stdout.write(JSON.stringify(answer));
`

describe.skipIf(!builtEntries.every(entry => existsSync(entry)))('the BUILT package root and ./credential-access', () => {
  it('read one directory state: the reader attached through ctx.consoleMembers and the registry', async () => {
    const temporary = realpathSync.native(tmpdir())
    const top = realpathSync.native(mkdtempSync(join(temporary, 'dsh-console-members-built-')))
    try {
      expect(top.startsWith(`${temporary}${sep}`)).toBe(true)
      const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', builtProbe], {
        cwd: packageRoot,
        env: { ...process.env, DSH_HOME: join(top, 'home'), PROBE_BASE: join(top, 'base') },
      })
      expect(JSON.parse(stdout)).toEqual({ read: 'token-a', principals: ['member-b'], afterRelease: null })
    } finally {
      rmSync(top, { recursive: true, force: true })
    }
  })
})
