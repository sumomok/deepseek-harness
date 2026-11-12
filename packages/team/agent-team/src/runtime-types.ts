/** Host-only Team service requests carrying child Agent configuration. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'

/** Input for creating one durable teammate after backend capability validation. */
export interface SpawnTeammateRequest {
  readonly name: string
  readonly description: string
  readonly prompt: ContentBlock[]
  readonly context: 'fresh' | 'fork'
  /** Continuable backend name, independent of the child's LLM provider. */
  readonly provider: string
  /** Child Agent overrides; requires the backend's agentOptions capability. */
  readonly agentOptions?: AgentOptions
  readonly signal: AbortSignal
}
