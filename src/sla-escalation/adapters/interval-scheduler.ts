/**
 * In-process `SchedulerPort` adapter for unit-sla-escalation.
 *
 * Dev/test / single-instance implementation. Drives `runScanTick` on a
 * `setInterval` cadence and also supports a MANUAL `tick(nowMs)` for
 * deterministic tests (the same injected-cadence discipline the unit's
 * `tech-stack-decisions` Scheduling section prescribes). Production swaps a
 * cron / EventBridge Scheduler binding behind the same port — deferred to
 * infrastructure-design, isolated by this seam.
 *
 * At-least-once + idempotent (`business-rules` `BR-SLA-6`): a double-fire or a
 * retried tick is safe because the ledger dedupe key — not this scheduler —
 * guarantees at-most-once dispatch. This adapter therefore makes no exclusivity
 * or leader-election guarantee (`tech-stack-decisions` Concurrency safety).
 */

import type { SchedulerPort, ScanTickHandler } from '../ports/scheduler-port.js';

export interface IntervalSchedulerDeps {
  /** Cadence in ms (production placeholder 15 min — infrastructure-design decides). */
  readonly intervalMs: number;
  /** Injected clock for the tick timestamp (defaults to `Date.now`). */
  readonly now?: () => number;
}

export class IntervalScheduler implements SchedulerPort {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private handler?: ScanTickHandler;
  private timer?: ReturnType<typeof setInterval>;

  constructor(deps: IntervalSchedulerDeps) {
    this.intervalMs = deps.intervalMs;
    this.now = deps.now ?? Date.now;
  }

  onTick(handler: ScanTickHandler): void {
    this.handler = handler;
    this.timer = setInterval(() => {
      // Fire-and-forget; the handler is non-blocking and never throws back
      // (`BR-SLA-8`). Any rejection is swallowed so a bad tick cannot crash the
      // interval loop — correctness is recovered on the next cadence.
      void this.fire();
    }, this.intervalMs);
    // Do not keep the event loop alive solely for the scanner (dev ergonomics).
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Manually drive one tick with an explicit timestamp — the deterministic
   * test entry point (`tech-stack-decisions` Dev/test scheduler). Awaits the
   * handler so tests can assert on its completion.
   */
  async tick(nowMs?: number): Promise<void> {
    if (!this.handler) return;
    await this.handler(nowMs ?? this.now());
  }

  private async fire(): Promise<void> {
    if (!this.handler) return;
    try {
      await this.handler(this.now());
    } catch {
      // Non-fatal: a failed tick is recovered on the next cadence + catch-up
      // (`BR-SLA-6a`). Never surface up (`BR-SLA-8`).
    }
  }
}
