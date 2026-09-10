import { describe, it, expect } from 'vitest';
import {
  evaluate,
  classify,
  pendingStageOf,
  elapsedMs,
  tiersUpTo,
  validatePolicy,
} from './sla-policy.js';
import type { EscalationPolicy, PendingRequestView, SlaThresholds } from './value-objects.js';
import { SlaError } from './errors.js';

/**
 * Exhaustive unit tests for the PURE SLA policy core (`business-logic-model`
 * Workflow S-B; `business-rules` `BR-SLA-2/3/4/4a/6a/9`). No I/O — the p99 ≤ 1 ms
 * evaluation path (`logical-components` C3). The clock is passed as a value for
 * determinism.
 */

const HOUR = 60 * 60 * 1000;

const teamLead: SlaThresholds = { reminderAfterMs: 24 * HOUR, escalateAfterMs: 48 * HOUR };
const hr: SlaThresholds = { reminderAfterMs: 48 * HOUR, escalateAfterMs: 96 * HOUR };
const policy: EscalationPolicy = { thresholds: { TeamLead: teamLead, HR: hr } };

function view(overrides: Partial<PendingRequestView> = {}): PendingRequestView {
  return {
    requestId: 'req-1',
    ownerId: 'emp-1',
    department: 'engineering',
    status: 'Submitted',
    enteredCurrentStatusAtMs: 0,
    ...overrides,
  };
}

describe('pendingStageOf (BR-SLA-1)', () => {
  it('maps Submitted -> TeamLead and Validated -> HR', () => {
    expect(pendingStageOf('Submitted')).toBe('TeamLead');
    expect(pendingStageOf('Validated')).toBe('HR');
  });

  it('returns null for terminal / out-of-scope statuses (BR-SLA-9)', () => {
    expect(pendingStageOf('Approved')).toBeNull();
    expect(pendingStageOf('Rejected')).toBeNull();
    expect(pendingStageOf('Withdrawn')).toBeNull();
  });
});

describe('elapsedMs (BR-SLA-3)', () => {
  it('computes wall-clock delta', () => {
    expect(elapsedMs(1000, 4000)).toBe(3000);
  });

  it('clamps a future/skewed entry time to 0 (never negative)', () => {
    expect(elapsedMs(5000, 1000)).toBe(0);
  });
});

describe('classify (BR-SLA-4, highest crossed tier)', () => {
  it('is OnTrack below the reminder threshold', () => {
    expect(classify(23 * HOUR, teamLead)).toBe('OnTrack');
  });

  it('is ReminderDue at/after the reminder threshold', () => {
    expect(classify(24 * HOUR, teamLead)).toBe('ReminderDue');
    expect(classify(47 * HOUR, teamLead)).toBe('ReminderDue');
  });

  it('is EscalationDue at/after the escalation threshold', () => {
    expect(classify(48 * HOUR, teamLead)).toBe('EscalationDue');
    expect(classify(1000 * HOUR, teamLead)).toBe('EscalationDue');
  });

  it('is OnTrack when the stage has no thresholds (uncovered stage)', () => {
    expect(classify(1000 * HOUR, undefined)).toBe('OnTrack');
  });
});

describe('tiersUpTo (BR-SLA-6a catch-up)', () => {
  it('returns [] for OnTrack', () => {
    expect(tiersUpTo('OnTrack')).toEqual([]);
  });

  it('returns [Reminder] for ReminderDue', () => {
    expect(tiersUpTo('ReminderDue')).toEqual(['Reminder']);
  });

  it('returns [Reminder, Escalation] for EscalationDue (catch-up in order)', () => {
    expect(tiersUpTo('EscalationDue')).toEqual(['Reminder', 'Escalation']);
  });
});

describe('evaluate (pure, BR-SLA-2/9)', () => {
  it('classifies a submitted request against the TeamLead policy', () => {
    const result = evaluate(view({ enteredCurrentStatusAtMs: 0 }), 25 * HOUR, policy);
    expect(result.stage).toBe('TeamLead');
    expect(result.elapsedMs).toBe(25 * HOUR);
    expect(result.tier).toBe('ReminderDue');
    expect(result.thresholds).toEqual(teamLead);
  });

  it('uses the HR clock for a validated request', () => {
    const result = evaluate(view({ status: 'Validated', enteredCurrentStatusAtMs: 0 }), 96 * HOUR, policy);
    expect(result.stage).toBe('HR');
    expect(result.tier).toBe('EscalationDue');
  });

  it('is OnTrack for a terminal status (BR-SLA-9)', () => {
    const result = evaluate(view({ status: 'Approved' }), 1000 * HOUR, policy);
    expect(result.tier).toBe('OnTrack');
    expect(result.elapsedMs).toBe(0);
  });
});

describe('validatePolicy (BR-SLA-4a, fail-closed)', () => {
  it('returns the policy when thresholds are monotonic and positive', () => {
    expect(validatePolicy(policy)).toBe(policy);
  });

  it('throws MISCONFIGURED_POLICY when no stages are configured', () => {
    expect(() => validatePolicy({ thresholds: {} })).toThrowError(SlaError);
  });

  it('throws when reminderAfterMs is not < escalateAfterMs', () => {
    const bad: EscalationPolicy = { thresholds: { TeamLead: { reminderAfterMs: 48 * HOUR, escalateAfterMs: 24 * HOUR } } };
    expect(() => validatePolicy(bad)).toThrowError(/reminderAfterMs must be < escalateAfterMs/);
  });

  it('throws when reminderAfterMs is not positive', () => {
    const bad: EscalationPolicy = { thresholds: { HR: { reminderAfterMs: 0, escalateAfterMs: 10 } } };
    expect(() => validatePolicy(bad)).toThrowError(/reminderAfterMs must be > 0/);
  });
});
