/**
 * The one key no mapping of a view's spec may carry, wherever the mapping sits.
 *
 * A mapping that holds it as a key is not wrong to read: the YAML readers and
 * the model's JSON parser both keep it as one more key. It is refused because
 * some reader of the same value copies a mapping by assignment, and the value
 * under the key would become that mapping's prototype instead of a key, so two
 * readers of one value would disagree on what it holds. One sentence states
 * that at every place a mapping's keys are read — the view walk before
 * judgement, and judgement's own key loops — so the rule reads as one rule.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/proto-key
 */

/** The key whose presence no mapping of a view's spec may carry. */
export const PROTO_KEY = '__proto__'

/** The one refusal every read of a mapping's keys gives that key: one sentence, ending in a period, as every refusal detail does. */
export const PROTO_KEY_REASON = `is a key named ${PROTO_KEY}, which no mapping of a view may carry: copied by assignment, `
  + 'the value under it becomes the mapping\'s prototype instead of a key, so two readers of one file would disagree on what it holds.'
