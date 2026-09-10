/**
 * `SchedulerPort` — the inbound trigger seam for unit-sla-escalation
 * (functional-design `domain-entities` Ports).
 *
 * This is the seam that makes the unit TIMER-DRIVEN, not event-driven — the key
 * distinction from `unit-notifications` (`business-logic-model` Data Flow &
 * Integration Points). Reminders fire on the ABSENCE of a transition (elapsed
 * pending time), which no event can signal.
 *
 * The port abstracts the timer so dev/test drive ticks deterministically (an
 * in-process interval or a manual `runScanTick(nowMs)` call) and production
 * wires a cron / EventBridge Scheduler behind the same shape — the concrete
 * binding is deferred to infrastructure-design (`tech-stack-decisions`
 * Scheduling), the same hexagonal seam as `SessionStore` / `EventPublisher`.
 */

/** A scan-tick handler invoked with the current wall-clock (epoch ms). */
export type ScanTickHandler = (nowMs: number) => Promise<void>;

export interface SchedulerPort {
  /**
   * Register the handler invoked on each cadence tick. Implementations may
   * double-fire or retry — correctness comes from the ledger dedupe key, not
   * exactly-once scheduling (`business-rules` `BR-SLA-6`).
   */
  onTick(handler: ScanTickHandler): void;

  /** Stop invoking the handler (dev/test teardown; graceful prod shutdown). */
  stop(): void;
}
