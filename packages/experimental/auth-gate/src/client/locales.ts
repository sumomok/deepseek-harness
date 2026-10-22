/** `authGate` namespace dictionaries: the notice shown when the site no longer accepts this page's sign-in. */

/** Dictionary namespace this plugin owns. */
export const NS = 'authGate'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'refused.text': '登录已失效，请在原系统重新登录后刷新本页。',
} satisfies Record<string, string>

/** The authGate namespace key union. */
export type AuthGateKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'refused.text': 'Your sign-in is no longer accepted. Sign in again in the original system, then refresh this page.',
} satisfies Record<AuthGateKey, string>
