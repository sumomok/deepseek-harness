/**
 * Every sentence the picture read puts in front of the USER: the card asking
 * whether to change the session's model, and the labels of what it offers.
 *
 * These are the only strings of this package a person reads rather than a
 * model, and they are written for one: no attachment id, no provider or model
 * id, no modality, no tool name. They are host-side literals in Chinese, the
 * way `act-text.ts` writes the approval request this package asks for; the
 * locale service is a browser-side one and the host has none, so a console set
 * to another language still shows these. The README's Known Limitations owns
 * that ceiling.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/switch-text
 */

/** The card's heading, which says what the question is about. */
export const MODEL_SWITCH_HEADER = '内容区的图'

/** The card's question. */
export const MODEL_SWITCH_QUESTION = '当前模型看不了图片，换一个能看图的模型吗？'

/**
 * The card's supporting detail. It states the two things a person needs before
 * choosing: the change lasts, and it is theirs to undo.
 */
export const MODEL_SWITCH_DETAIL = '换过之后，这次对话接下来都用你选的那个模型；你随时可以自己换回来。'

/** The label of the option that changes nothing. */
export const DECLINE_LABEL = '先不换'

/** What declining costs, said once on the option itself. */
export const DECLINE_DESCRIPTION = '这次就不看这张图了'

/**
 * One model option's label, which is also the identity the answer comes back
 * as. It names the provider and the model and nothing else: every option on
 * this card can look at pictures, so saying so on each would distinguish none
 * of them.
 * @param provider - the provider's own display name.
 * @param model - the model's own display name.
 * @returns the label.
 */
export function routeLabel(provider: string, model: string): string {
  return `${provider}：${model}`
}

/**
 * The same label where another candidate already carries it. A provider and a
 * model id are unique together, so adding the id makes the label unique.
 * @param label - the label two candidates share.
 * @param model - the model id that tells them apart.
 * @returns the distinguishing label.
 */
export function distinctRouteLabel(label: string, model: string): string {
  return `${label} · ${model}`
}
