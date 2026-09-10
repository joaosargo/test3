/**
 * Scheduler wiring for unit-sla-escalation.
 *
 * Binds a `SchedulerPort`'s tick to `SlaScanService.runScanTick` — the inbound
 * TIMER seam (`business-logic-model` Data Flow & Integration Points). Unlike
 * `unit-notifications` (an `EventPublisher` subscriber), this unit fires on the
 * ABSENCE of a transition (elapsed time), so it is driven by a scheduler, not an
 * event bus. Used by the composition root to wire the scanner in dev/test;
 * production swaps a cron / cloud-scheduler binding behind the same
 * `SchedulerPort` shape.
 *
 * Non-blocking (`business-rules` `BR-SLA-8`): the handler always resolves and
 * never throws back at the scheduler — a scan failure is a value in the
 * `ScanSummary`, never a thrown error that could stall the timer.
 */

import type { SchedulerPort } from './ports/scheduler-port.js';
import type { SlaScanService } from './services/sla-scan-service.js';

/**
 * Register `service.runScanTick` as the scheduler's tick handler. Returns the
 * scheduler for fluent teardown (`scheduler.stop()`).
 */
export function registerSlaScheduler(scheduler: SchedulerPort, service: SlaScanService): SchedulerPort {
  scheduler.onTick(async (nowMs: number) => {
    await service.runScanTick(nowMs);
  });
  return scheduler;
}
