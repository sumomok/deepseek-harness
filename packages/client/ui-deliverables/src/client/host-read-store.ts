/**
 * Fetch-once cache of Host-served records keyed by their authenticated URL:
 * one read per URL while a state stands, cleared on connection replacement,
 * cancelled on disposal. Each store decides what a response means and which
 * states a later request reads again.
 */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What one store makes of its reads. */
export interface HostReadPolicy<T> {
  /** The state published while a request runs. */
  loading: T
  /** The state a transport failure publishes. */
  failed: T
  /** Maximum settled unpinned entries kept before LRU eviction. */
  maxEntries: number
  /**
   * Whether a later request replaces a standing state with a new read.
   * @param state - the standing state.
   * @returns true to read again.
   */
  retryable(state: T): boolean
  /**
   * Turn a settled response into a state.
   * @param response - the Host's answer.
   * @returns the state to publish.
   */
  decode(response: Response): Promise<T>
}

/** One browser plugin's reads of one record kind. */
export class HostReadStore<T> {
  /** Record URLs key the state across Sessions and turns. */
  readonly state = createSnapshotStore<Record<string, T | undefined>>({})
  private readonly lifetime = new AbortController()
  /** The connection generation the current states belong to; a reset aborts it so no older read publishes. */
  private generation = new AbortController()
  private readonly pending = new Set<Promise<void>>()
  private readonly order = new Set<string>()
  private readonly pinned = new Map<string, number>()

  constructor(private readonly policy: HostReadPolicy<T>) {}

  /**
   * Pin one URL so LRU eviction keeps its entry while at least one consumer holds it.
   * @param url - the record's authenticated URL.
   * @returns idempotent release callback that unpins the URL and evicts excess entries.
   */
  retain(url: string): () => void {
    this.pinned.set(url, (this.pinned.get(url) ?? 0) + 1)
    let active = true
    return () => {
      if (!active) return
      active = false
      const next = (this.pinned.get(url) as number) - 1
      if (next > 0) this.pinned.set(url, next)
      else {
        this.pinned.delete(url)
        if (this.order.size > this.policy.maxEntries) {
          this.state.update((state) => { this.evictDraft(state) })
        }
      }
    }
  }

  /**
   * Read one URL unless a state the policy keeps already stands for it.
   * @param url - the record's authenticated URL.
   * @returns after the state is published.
   */
  protected async loadUrl(url: string): Promise<void> {
    if (this.lifetime.signal.aborted) return
    const current = this.state.getSnapshot()[url]
    if (current !== undefined && !this.policy.retryable(current)) {
      this.touch(url)
      return
    }
    this.touch(url)
    this.state.update((state) => {
      state[url] = this.policy.loading
      this.evictDraft(state, url)
    })
    const task = this.read(url, AbortSignal.any([this.lifetime.signal, this.generation.signal]))
    this.pending.add(task)
    try {
      await task
    } finally {
      this.pending.delete(task)
    }
  }

  /** Forget every state and abandon in-flight reads; a replaced connection may reach a Host that no longer serves them. */
  reset(): void {
    this.generation.abort()
    this.generation = new AbortController()
    this.order.clear()
    this.state.set({})
  }

  /** Cancel outstanding reads and wait until none can publish state. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.all(this.pending)
  }

  private async read(url: string, signal: AbortSignal): Promise<void> {
    let next: T
    try {
      next = await this.policy.decode(await fetch(url, { signal }))
    } catch {
      // A transport failure publishes the policy's failed state until the connection is replaced and the store reset.
      next = this.policy.failed
    }
    if (!signal.aborted) {
      this.touch(url)
      this.state.update((state) => {
        state[url] = next
        this.evictDraft(state, url)
      })
    }
  }

  private touch(url: string): void {
    this.order.delete(url)
    this.order.add(url)
  }

  private evictDraft(state: Record<string, T | undefined>, keepUrl?: string): void {
    for (const candidate of this.order) {
      if (this.order.size <= this.policy.maxEntries) break
      if (candidate === keepUrl || this.pinned.has(candidate) || state[candidate] === this.policy.loading) continue
      Reflect.deleteProperty(state, candidate)
      this.order.delete(candidate)
    }
  }
}
