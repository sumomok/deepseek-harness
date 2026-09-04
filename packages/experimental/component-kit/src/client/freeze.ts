/**
 * Deep freeze, the one preparation a value needs before Vue 2 may see it.
 *
 * Vue 2 makes a value reactive by walking it and rewriting what it finds:
 * every own property becomes a getter/setter pair, an array's prototype is
 * swapped for a patched one, and an `__ob__` observer is stamped on. It does
 * that to whatever a component receives, however deep. A record React still
 * holds would come back rewritten, and the two frameworks would then disagree
 * about what changed.
 *
 * Vue skips a value it cannot extend, so freezing is the whole defense. A
 * shallow freeze is not enough — it stops the walk at the record itself and
 * leaves every nested array and object open.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/freeze
 */

/**
 * Freeze `value` and everything reachable from it, in place.
 *
 * In place, not a copy: the caller's own nested arrays and objects are the ones
 * Vue would otherwise observe, so they are the ones that must become
 * non-extensible. Callers hand over data they already treat as immutable — a
 * block's validated properties — so nothing loses a write it was entitled to.
 *
 * An already-frozen value is left alone, which also terminates on a cycle.
 * @param value - the value to freeze; a primitive or function is returned untouched.
 * @returns the same value, frozen.
 */
export function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const nested of Object.values(value as Record<string, unknown>)) freezeDeep(nested)
  return value
}
