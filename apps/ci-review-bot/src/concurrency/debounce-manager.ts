import type { Redis } from 'ioredis';

/**
 * Debounce manager — FR-DEB-001..006.
 * Scoped by tenant + repo + PR; each new synchronize event resets the window
 * (FR-DEB-002) up to a hard maximum (FR-DEB-006). Latest head SHA wins
 * (FR-DEB-003). Redis is acceptable here: debounce state is hot-path
 * scheduling, not posting authority (FR-EXEC-003).
 */
export class DebounceManager {
  constructor(
    private readonly redis: Redis,
    private readonly policy: { debounceSeconds: number; maxDebounceSeconds: number },
  ) {}

  private key(tenantId: string, repo: string, prId: number): string {
    return `tenant:${tenantId}:pr:debounce:${repo}:${prId}`;
  }

  private static readonly DUE_SET = 'pr:debounce:due';

  private static member(tenantId: string, repo: string, prId: number): string {
    return `${tenantId}|${repo}|${prId}`;
  }

  /**
   * Records an event; returns the deadline (epoch ms) when the debounce
   * window settles. Callers schedule evaluation at that deadline and then
   * call `settle` to atomically consume the latest SHA.
   */
  async recordEvent(tenantId: string, repo: string, prId: number, headSha: string): Promise<number> {
    const key = this.key(tenantId, repo, prId);
    const now = Date.now();
    const windowEnd = now + this.policy.debounceSeconds * 1000;
    const existing = await this.redis.hgetall(key);
    const firstEventAt = existing['first_event_at'] ? Number(existing['first_event_at']) : now;
    const maxEnd = firstEventAt + this.policy.maxDebounceSeconds * 1000;
    const deadline = Math.min(windowEnd, maxEnd);
    await this.redis.hset(key, {
      head_sha: headSha,
      first_event_at: String(firstEventAt),
      deadline: String(deadline),
    });
    await this.redis.pexpire(key, this.policy.maxDebounceSeconds * 1000 + 60_000);
    // Schedule for the executor's due-window scan (FR-EXEC-003: Redis is
    // acceptable for debounce scheduling; runs become durable at startRun).
    await this.redis.zadd(
      DebounceManager.DUE_SET,
      deadline,
      DebounceManager.member(tenantId, repo, prId),
    );
    return deadline;
  }

  /** Returns debounce windows whose deadline has passed (executor scan). */
  async dueWindows(
    nowMs = Date.now(),
    limit = 50,
  ): Promise<{ tenantId: string; repo: string; prId: number }[]> {
    const members = await this.redis.zrangebyscore(
      DebounceManager.DUE_SET,
      '-inf',
      nowMs,
      'LIMIT',
      0,
      limit,
    );
    return members.map((m) => {
      const [tenantId, repo, prId] = m.split('|') as [string, string, string];
      return { tenantId, repo, prId: Number(prId) };
    });
  }

  /**
   * Consumes the debounce window if its deadline has passed; returns the
   * latest head SHA or null when the window is still open / already consumed.
   */
  async settle(tenantId: string, repo: string, prId: number): Promise<string | null> {
    const key = this.key(tenantId, repo, prId);
    const state = await this.redis.hgetall(key);
    if (!state['head_sha'] || !state['deadline']) {
      await this.redis.zrem(DebounceManager.DUE_SET, DebounceManager.member(tenantId, repo, prId));
      return null;
    }
    if (Date.now() < Number(state['deadline'])) return null;
    await this.redis.del(key);
    await this.redis.zrem(DebounceManager.DUE_SET, DebounceManager.member(tenantId, repo, prId));
    return state['head_sha'];
  }
}
