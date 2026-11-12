/** Deterministic provider identities with real version guards in isolated snapshot processes. */
import { relative, sep } from 'node:path'

export const inject = ['fs']

/** @param {import('@deepseek-ai/cordis').Context} ctx - Isolated scenario context. */
export async function apply(ctx, config = {}) {
  const fs = ctx.fs
  const targets = new Map()
  const restrict = config.paths !== undefined
  for (const path of config.paths ?? []) {
    const target = await fs.resolve(path)
    targets.set(target.targetKey, { path, versions: new Map(), originals: new Map() })
  }
  const entryFor = (target) => {
    let entry = targets.get(target.targetKey)
    if (entry === undefined && !restrict) {
      const path = relative(process.cwd(), fs.processPath(target)).split(sep).join('/')
      entry = { path, versions: new Map(), originals: new Map() }
      targets.set(target.targetKey, entry)
    }
    return entry
  }
  const stable = (target, value) => {
    if (value === undefined || value.version === undefined) return value
    const entry = entryFor(target)
    if (entry === undefined) return value
    let version = entry.versions.get(value.version)
    if (version === undefined) {
      version = `snapshot-file:${entry.path}:${entry.versions.size + 1}`
      entry.versions.set(value.version, version)
      entry.originals.set(version, value.version)
    }
    return { ...value, version }
  }
  const originalGuard = (target, guard) => {
    if (guard === undefined || guard.version === undefined) return guard
    const version = targets.get(target.targetKey)?.originals.get(guard.version)
    return version === undefined ? guard : { ...guard, version }
  }
  const originals = {
    stat: fs.stat, listDir: fs.listDir, writeText: fs.writeText, editText: fs.editText,
    patchText: fs.patchText, deleteFile: fs.deleteFile, moveFile: fs.moveFile,
  }
  ctx.effect(() => {
    fs.stat = async function (target, signal) {
      return stable(target, await originals.stat.call(this, target, signal))
    }
    fs.listDir = async function (...args) {
      return (await originals.listDir.apply(this, args)).map(entry => stable(entry.target, entry))
    }
    fs.writeText = async function (target, content, guard, ...args) {
      return stable(target, await originals.writeText.call(this, target, content, originalGuard(target, guard), ...args))
    }
    fs.editText = async function (target, edit, guard, ...args) {
      return stable(target, await originals.editText.call(this, target, edit, originalGuard(target, guard), ...args))
    }
    fs.patchText = async function (target, hunks, guard, ...args) {
      return stable(target, await originals.patchText.call(this, target, hunks, originalGuard(target, guard), ...args))
    }
    fs.deleteFile = function (target, guard, ...args) {
      return originals.deleteFile.call(this, target, originalGuard(target, guard), ...args)
    }
    fs.moveFile = async function (source, destination, options, ...args) {
      const result = await originals.moveFile.call(this, source, destination, {
        ...options,
        expectedSource: originalGuard(source, options.expectedSource),
        expectedDestination: originalGuard(destination, options.expectedDestination),
      }, ...args)
      return { ...result, destination: stable(destination, result.destination) }
    }
    return () => { Object.assign(fs, originals) }
  })
}
