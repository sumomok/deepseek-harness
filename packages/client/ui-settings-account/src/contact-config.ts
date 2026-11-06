/** Public contact and bonus notice options shared by Host and Client. */
import z from '@deepseek-ai/schemastery'

/** Questionnaire destination and bonus notice timings shared by Host and Client. */
export interface ContactConfig {
  /** HTTPS questionnaire URL; override for a test form. */
  contactFormUrl: string
  /** Questionnaire source option; empty until Harness is supported by the form. */
  contactSource: string
  /** First delay before retrying a failed bonus acknowledgement. */
  bonusAckRetryDelayMs: number
  /** Ceiling for the acknowledgement retry backoff. */
  bonusAckRetryMaxDelayMs: number
  /** First delay before re-reading account details the first frame left missing. */
  detailsRetryDelayMs: number
  /** Ceiling for the account detail retry backoff. */
  detailsRetryMaxDelayMs: number
  /** Retries allowed for one signed-in account before the recovery chain stops. */
  detailsRetryAttempts: number
}
/** Validate public questionnaire options. */
export const ContactConfigFields = {
  contactFormUrl: z.string().pattern(/^https:\/\/[^/\s]+\//).default('https://trtgsjkv6r.feishu.cn/share/base/form/shrcnlCoGElW7MQznGy9r3YYXcg?hide_uid=1&hide_device_info=1&hide_harness_version=1'),
  contactSource: z.string().default(''),
  bonusAckRetryDelayMs: z.number().min(1).default(1_000),
  bonusAckRetryMaxDelayMs: z.number().min(1).default(60_000),
  detailsRetryDelayMs: z.number().min(1).default(1_500),
  detailsRetryMaxDelayMs: z.number().min(1).default(30_000),
  detailsRetryAttempts: z.number().min(0).max(10).step(1).default(4),
}
/** Validate public questionnaire options. */
export const ContactConfig: z<Partial<ContactConfig>, ContactConfig> = z.object(ContactConfigFields)
/** Bootstrap key containing no account credentials. */
export const CONTACT_CONFIG_GLOBAL = '__DSH_CONTACT_CONFIG__'
