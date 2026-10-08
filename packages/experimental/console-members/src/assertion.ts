/**
 * Verification of the signed member assertion that the deployment proxy puts
 * on every HTTP request and WebSocket upgrade it forwards.
 *
 * The value is `v1.<payload>.<signature>`. `<payload>` is the unpadded
 * base64url form of the UTF-8 JSON object `{"p","aud","exp"}`: `p` is the
 * member's `login_uid`, `aud` the deployment id, and `exp` the Unix second
 * the assertion stops being valid. `<signature>` is the unpadded base64url
 * Ed25519 signature of the ASCII text `v1.<payload>`. The verifier allows no
 * clock skew and sets no upper bound on `exp`.
 * @module @deepseek-ai/dsh-experimental-console-members/src/assertion
 */

import { verify, type KeyObject } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ConnectionTrustRequest } from '@deepseek-ai/dsh-client-connection'
import type { PrincipalKey } from './types.ts'

/** The form an assertion must have before any part of it is decoded. */
const ASSERTION_FORM = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

/** The payload fields, sorted; a payload has exactly these. */
const PAYLOAD_FIELDS = 'aud,exp,p'

/**
 * Why an assertion was refused. Each reason is a fixed word: none carries any
 * part of the header value.
 */
export type AssertionRefusal =
  /** The request has no assertion header. */
  | 'missing'
  /** The header arrived as a list of values. */
  | 'repeated'
  /** The value is not `v1.<payload>.<signature>` in the base64url alphabet; a comma-joined repeated header lands here. */
  | 'malformed'
  /** The signature does not verify against the configured key. */
  | 'signature'
  /** The signed payload is not a JSON object with exactly `p`, `aud` and `exp`, a non-empty string `p`, and an integer `exp`. */
  | 'payload'
  /** `aud` is not the configured deployment id. */
  | 'audience'
  /** The current second is at or after `exp`. */
  | 'expired'

/** The outcome of verifying one request's assertion. */
export type AssertionVerdict =
  | { readonly principal: PrincipalKey }
  | { readonly refusal: AssertionRefusal }

/** What an assertion is verified against. */
export interface AssertionCheck {
  /** The header name, in lower case. */
  readonly header: string
  /** The Ed25519 public key. */
  readonly key: KeyObject
  /** The value `aud` must equal. */
  readonly deploymentId: string
}

/**
 * Verify the member assertion one request carries. The header is read by its
 * lower-case name only, from a `Headers` object or a plain header record. The
 * form is checked before anything is decoded, the signature before the
 * payload is parsed, and the payload fields before the expiry.
 * @param headers - the request's headers.
 * @param check - the header name, key and deployment id from Config.
 * @param nowSeconds - the current Unix time in whole seconds.
 * @returns the member the assertion names, or the reason it was refused.
 */
export function verifyAssertion(
  headers: ConnectionTrustRequest['headers'],
  check: AssertionCheck,
  nowSeconds: number,
): AssertionVerdict {
  const value = headers instanceof Headers ? headers.get(check.header) ?? undefined : headers[check.header]
  if (Array.isArray(value)) return { refusal: 'repeated' }
  if (typeof value !== 'string') return { refusal: 'missing' }
  if (!ASSERTION_FORM.test(value)) return { refusal: 'malformed' }
  const [version, payload, signature] = value.split('.') as [string, string, string]
  const signed = Buffer.from(`${version}.${payload}`, 'ascii')
  if (!verify(null, signed, check.key, Buffer.from(signature, 'base64url'))) return { refusal: 'signature' }
  const fields = payloadFields(payload)
  const principal = fields?.get('p')
  const expiry = fields?.get('exp')
  if (fields === undefined || [...fields.keys()].sort().join(',') !== PAYLOAD_FIELDS
    || typeof principal !== 'string' || principal.length === 0 || typeof expiry !== 'number' || !Number.isInteger(expiry)) {
    return { refusal: 'payload' }
  }
  if (fields.get('aud') !== check.deploymentId) return { refusal: 'audience' }
  if (nowSeconds >= expiry) return { refusal: 'expired' }
  return { principal: brandString<PrincipalKey>(principal) }
}

/**
 * Decode the payload part into the fields of a JSON object.
 * @param payload - the base64url payload part.
 * @returns its fields, or `undefined` when it is not a JSON object.
 */
function payloadFields(payload: string): Map<string, unknown> | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch (_notJson) {
    // A signed payload that is not JSON is refused like any other bad payload; the parser's text is dropped.
    return undefined
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? new Map(Object.entries(parsed)) : undefined
}
