/**
 * The configuration of the console member directory row and the checks the
 * row runs on it at load.
 *
 * Every field is ordinary Config, none of them `.volatile()`: a deployment
 * writes them in its lock layer, and the settings service offers no form for
 * them. `admins` and each `rootSeeds[].principal` hold `login_uid` values, so
 * the schema accepts any value for those two fields and {@link readSettings}
 * checks them, the list itself included, with errors that name the field and
 * index only: the schema's own errors would quote the rejected value.
 * @module @deepseek-ai/dsh-experimental-console-members/src/config
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { HostConnectionPeers } from '@deepseek-ai/dsh-client-connection'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import z from '@deepseek-ai/schemastery'
import type { PrincipalKey } from './types.ts'

/** A migration seed that registers one root to one member. */
export interface MemberRootSeed {
  /** The root's absolute path. */
  path: string
  /** The `login_uid` of the member the root is registered to. */
  principal: string
}

/** A migration seed that registers one root to no member. */
export interface UnownedRootSeed {
  /** The root's absolute path. */
  path: string
  /** Marks the root as registered to no member. */
  owner: 'none'
}

/** One entry of {@link Config.rootSeeds}. */
export type RootSeed = MemberRootSeed | UnownedRootSeed

/** The console member directory row's configuration. */
export interface Config {
  /** Name of the request header that carries the signed member assertion; compared in lower case. */
  assertionHeader: string
  /** The Ed25519 public key that verifies member assertions, as SPKI PEM (`-----BEGIN PUBLIC KEY-----`). Required. */
  assertionPublicKey: string
  /** The deployment id an assertion's `aud` must equal. Required. */
  deploymentId: string
  /** The `login_uid` of every member who is an administrator. This build checks it at load and grants nothing for it. */
  admins: string[]
  /** Absolute path of the directory that holds one root per member, `<membersRoot>/<directory id>`. Required. */
  membersRoot: string
  /** Absolute paths every member may read. This build checks them at load and grants no read for them. */
  sharedReadRoots: string[]
  /**
   * Migration seeds merged into the root registry at load: each registers one
   * absolute path to one member or to no member. A seed that conflicts with
   * the registry fails the load.
   */
  rootSeeds: RootSeed[]
  /** Absolute path prefixes a read may reach while no member is current. This build checks them at load and limits no read. */
  hostReadPaths: string[]
  /** Absolute path prefixes a write may reach while no member is current. This build checks them at load and limits no write. */
  hostWritePaths: string[]
  /** Milliseconds a member Peer with no socket and no HTTP request stays open; at most 2147483647, the longest `setTimeout` delay. */
  peerIdleMs: number
}

export const Config: z<Config> = z.object({
  assertionHeader: z.string().default('x-dsh-member'),
  assertionPublicKey: z.string().required(),
  deploymentId: z.string().required(),
  admins: z.any().default([]),
  membersRoot: z.string().required(),
  sharedReadRoots: z.array(z.string()).default([]),
  rootSeeds: z.any().default([]),
  hostReadPaths: z.array(z.string()).default([]),
  hostWritePaths: z.array(z.string()).default([]),
  peerIdleMs: z.natural().min(1).max(MAX_TIMER_DELAY_MS).default(600_000),
})

/** One migration seed after {@link readSettings} checked it. */
export type CheckedRootSeed =
  | { readonly path: string; readonly owner: 'member'; readonly principal: PrincipalKey }
  | { readonly path: string; readonly owner: 'none' }

/** The configuration after {@link readSettings} checked and normalized it. */
export interface MemberSettings {
  /** The assertion header name in lower case, the form Node gives request header names. */
  readonly assertionHeader: string
  /** The deployment id an assertion's `aud` must equal. */
  readonly deploymentId: string
  /** The administrators' principal keys. */
  readonly admins: readonly PrincipalKey[]
  /** Absolute path of the directory that holds the member roots. */
  readonly membersRoot: string
  /** Absolute paths every member may read. */
  readonly sharedReadRoots: readonly string[]
  /** The checked migration seeds, in configuration order. */
  readonly rootSeeds: readonly CheckedRootSeed[]
  /** Absolute read prefixes for calls with no current member. */
  readonly hostReadPaths: readonly string[]
  /** Absolute write prefixes for calls with no current member. */
  readonly hostWritePaths: readonly string[]
  /** Milliseconds an idle member Peer stays open. */
  readonly peerIdleMs: number
}

/** The characters RFC 9110 allows in a header field name. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/**
 * Check the fields the schema leaves open and normalize the assertion header
 * name. Errors name the field and, for a list, the index; they quote no
 * `login_uid`.
 * @param config - the configuration the schema accepted.
 * @returns the checked settings.
 * @throws {Error} when a field holds a value the row cannot use.
 */
export function readSettings(config: Config): MemberSettings {
  if (!HEADER_NAME.test(config.assertionHeader)) {
    throw new Error('console-members: assertionHeader must be a non-empty HTTP header name')
  }
  if (config.deploymentId.length === 0) throw new Error('console-members: deploymentId must not be empty')
  requireAbsolute('membersRoot', config.membersRoot)
  for (const [field, paths] of [
    ['sharedReadRoots', config.sharedReadRoots],
    ['hostReadPaths', config.hostReadPaths],
    ['hostWritePaths', config.hostWritePaths],
  ] as const) {
    for (const [index, path] of paths.entries()) requireAbsolute(`${field}[${index}]`, path)
  }
  return {
    assertionHeader: config.assertionHeader.toLowerCase(),
    deploymentId: config.deploymentId,
    admins: listAt('admins', config.admins).map((admin, index) => principalAt(`admins[${index}]`, admin)),
    membersRoot: config.membersRoot,
    sharedReadRoots: config.sharedReadRoots,
    rootSeeds: listAt('rootSeeds', config.rootSeeds).map((seed, index) => checkSeed(index, seed)),
    hostReadPaths: config.hostReadPaths,
    hostWritePaths: config.hostWritePaths,
    peerIdleMs: config.peerIdleMs,
  }
}

/**
 * Refuse a path that is not absolute.
 * @param field - the field the error names.
 * @param path - the configured path.
 * @throws {Error} when the path is relative.
 */
function requireAbsolute(field: string, path: string): void {
  if (!isAbsolute(path)) throw new Error(`console-members: ${field} must be an absolute path`)
}

/**
 * Read a field the schema accepts with any value as a list.
 * @param field - the field the error names.
 * @param value - the configured value.
 * @returns the list's elements, unchecked.
 * @throws {Error} naming the field, not the value, when the value is not a list.
 */
function listAt(field: 'admins' | 'rootSeeds', value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`console-members: ${field} must be a list`)
  return value
}

/**
 * Read one configured `login_uid`.
 * @param field - the field and index the error names.
 * @param value - the configured value.
 * @returns the value as a principal key.
 * @throws {Error} naming the field, not the value, when it is not a non-empty string.
 */
function principalAt(field: string, value: unknown): PrincipalKey {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`console-members: ${field} must be a non-empty login_uid string`)
  }
  return brandString<PrincipalKey>(value)
}

/**
 * Check one migration seed: exactly `{ path, principal }` or `{ path, owner: 'none' }`.
 * @param index - the seed's index in `rootSeeds`.
 * @param seed - the configured value.
 * @returns the checked seed.
 * @throws {Error} naming `rootSeeds[index]`, not its values, when the seed has neither form.
 */
function checkSeed(index: number, seed: unknown): CheckedRootSeed {
  const field = `rootSeeds[${index}]`
  if (typeof seed !== 'object' || seed === null || Array.isArray(seed)) {
    throw new Error(`console-members: ${field} must be { path, principal } or { path, owner: 'none' }`)
  }
  const entries = new Map<string, unknown>(Object.entries(seed))
  const path = entries.get('path')
  if (typeof path !== 'string') throw new Error(`console-members: ${field}.path must be a string`)
  requireAbsolute(`${field}.path`, path)
  const keys = [...entries.keys()].sort().join(',')
  if (keys === 'path,principal') return { path, owner: 'member', principal: principalAt(`${field}.principal`, entries.get('principal')) }
  if (keys === 'owner,path' && entries.get('owner') === 'none') return { path, owner: 'none' }
  throw new Error(`console-members: ${field} must be { path, principal } or { path, owner: 'none' }`)
}

/** The PEM label of an SPKI public key. */
const SPKI_PEM_LABEL = '-----BEGIN PUBLIC KEY-----'

/** The line that ends an SPKI public key block. */
const SPKI_PEM_END = '-----END PUBLIC KEY-----'

/**
 * Read the assertion verification key. A PKCS #8 private key would also yield
 * an Ed25519 public key, and the decoder reads only the first PEM block, so
 * the value must be exactly one block: it starts with the SPKI label, ends
 * with its end line, and has no other `-----` in between, so neither a second
 * block nor a second end line follows the key. The Host keeps the public key
 * only. Whitespace around the block is ignored. The error quotes no part of
 * the configured value.
 * @param pem - the configured `assertionPublicKey`.
 * @returns the Ed25519 public key.
 * @throws {Error} when the value is not one Ed25519 public key in SPKI PEM form.
 */
export function readAssertionKey(pem: string): KeyObject {
  const refusal = 'console-members: assertionPublicKey must be an Ed25519 public key in SPKI PEM form (-----BEGIN PUBLIC KEY-----)'
  const text = pem.trim()
  const inner = text.slice(SPKI_PEM_LABEL.length, text.length - SPKI_PEM_END.length)
  if (!text.startsWith(SPKI_PEM_LABEL) || !text.endsWith(SPKI_PEM_END) || inner.includes('-----')) {
    throw new Error(refusal)
  }
  let key: KeyObject
  try {
    key = createPublicKey({ key: text, format: 'pem' })
  } catch (_undecodable) {
    // The decoder's own message is replaced so that nothing derived from the value reaches the load error.
    throw new Error(refusal)
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(refusal)
  return key
}

/**
 * Refuse to load unless Connection refuses every request while no admitter is
 * installed: without it, the window between this row's load and its admitter
 * admits every request as the operator.
 * @param peers - Connection's member Peer registry.
 * @throws {Error} naming `requireAdmitter` when it is not `true`.
 */
export function requireDefaultDeny(peers: HostConnectionPeers): void {
  if (!peers.requireAdmitter) {
    throw new Error('console-members: the client-connection row must set requireAdmitter: true, '
      + 'so that requests are refused while no member admitter is installed')
  }
}
