/** Local macOS candidates seal their resources without a release certificate. */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.skipIf(process.platform !== 'darwin')('repairs inherited signatures for local candidates without reading signing material', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-local-sign-test-'))
  try {
    const app = join(root, 'Local Candidate.app')
    const contents = join(app, 'Contents')
    mkdirSync(join(contents, 'MacOS'), { recursive: true })
    mkdirSync(join(contents, 'Resources'))
    cpSync('/usr/bin/true', join(contents, 'MacOS', 'local-candidate'))
    writeFileSync(join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>dev.dsh.desktop.local-sign-test</string>
<key>CFBundleExecutable</key><string>local-candidate</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`)
    const resource = join(contents, 'Resources', 'payload.txt')
    writeFileSync(resource, 'before packaging')
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app])
    writeFileSync(resource, 'after packaging')
    expect(spawnSync('codesign', ['--verify', '--deep', '--strict', app]).status).not.toBe(0)

    const hook = fileURLToPath(new URL('../scripts/sign-mac.cjs', import.meta.url))
    execFileSync(process.execPath, ['-e', 'require(process.argv[1]).signMacApp({appPath: process.argv[2], log: console.log})', hook, app], {
      env: { ...process.env, DSH_MAC_SIGN: '0', DSH_MAC_SIGNING_P12: join(root, 'absent-signing-identity.p12') },
    })
    execFileSync('codesign', ['--verify', '--deep', '--strict', app])
    const signature = spawnSync('codesign', ['-dv', app], { encoding: 'utf8' })
    expect(signature.status).toBe(0)
    expect(signature.stderr).toContain('Signature=adhoc')
    expect(signature.stderr).not.toContain('Authority=')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
