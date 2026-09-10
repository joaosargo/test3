import { describe, it, expect } from 'vitest';
import { VacationRequest } from './vacation-request.js';

/**
 * Unit tests for the pure `VacationRequest` FSM aggregate — the two-stage
 * approve/reject-only workflow (business-rules BR-WF-*, BR-INV-*). No I/O; every
 * illegal transition is a Result.err, never a throw.
 */

function submitted(): VacationRequest {
  return VacationRequest.submit({
    id: 'req-1',
    ownerId: 'emp-1',
    department: 'engineering',
    dates: { startDate: '2999-01-10', endDate: '2999-01-12' },
    atMs: 1000,
  });
}

describe('VacationRequest aggregate — story-submit-request / story-lead-validate / story-hr-approve', () => {
  it('submit creates a Submitted request at version 1 with an initial transition (BR-WF-1, BR-INV-2)', () => {
    const r = submitted();
    expect(r.status).toBe('Submitted');
    expect(r.version).toBe(1);
    expect(r.history).toHaveLength(1);
    expect(r.history[0]).toMatchObject({ from: null, to: 'Submitted', actorId: 'emp-1' });
  });

  it('happy path: Submitted -> Validated -> Approved (BR-WF-4)', () => {
    const validated = submitted().validate('lead-1', 2000);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.value.status).toBe('Validated');
    expect(validated.value.version).toBe(2);

    const approved = validated.value.approve('hr-1', 3000);
    expect(approved.ok).toBe(true);
    if (!approved.ok) return;
    expect(approved.value.status).toBe('Approved');
    expect(approved.value.version).toBe(3);
    expect(approved.value.history).toHaveLength(3);
  });

  it('lead can reject a Submitted request, tagging the TeamLead stage (BR-WF-5)', () => {
    const rejected = submitted().rejectAtLead('lead-1', 2000, 'no coverage');
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.status).toBe('Rejected');
    expect(rejected.value.rejectedStage).toBe('TeamLead');
  });

  it('HR can reject a Validated request, tagging the HR stage (BR-WF-5)', () => {
    const validated = submitted().validate('lead-1', 2000);
    if (!validated.ok) return;
    const rejected = validated.value.rejectAtHr('hr-1', 3000);
    expect(rejected.ok).toBe(true);
    if (!rejected.ok) return;
    expect(rejected.value.rejectedStage).toBe('HR');
  });

  it('HR cannot approve a Submitted (not-yet-validated) request — no stage skip (BR-WF-2)', () => {
    const res = submitted().approve('hr-1', 2000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('lead cannot validate a Validated request (BR-WF-6)', () => {
    const validated = submitted().validate('lead-1', 2000);
    if (!validated.ok) return;
    const again = validated.value.validate('lead-2', 2500);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('terminal states accept no further transition (BR-WF-6)', () => {
    const validated = submitted().validate('lead-1', 2000);
    if (!validated.ok) return;
    const approved = validated.value.approve('hr-1', 3000);
    if (!approved.ok) return;
    const reopen = approved.value.rejectAtHr('hr-2', 4000);
    expect(reopen.ok).toBe(false);
    if (!reopen.ok) expect(reopen.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('owner may withdraw only from Submitted (BR-WF-9)', () => {
    const withdrawn = submitted().withdraw('emp-1', 2000);
    expect(withdrawn.ok).toBe(true);
    if (!withdrawn.ok) return;
    expect(withdrawn.value.status).toBe('Withdrawn');
  });

  it('withdraw after validation is illegal (BR-WF-9 conservative default)', () => {
    const validated = submitted().validate('lead-1', 2000);
    if (!validated.ok) return;
    const res = validated.value.withdraw('emp-1', 3000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ILLEGAL_TRANSITION');
  });

  it('transitions are immutable — the original aggregate is unchanged (BR-INV-4)', () => {
    const original = submitted();
    original.validate('lead-1', 2000);
    expect(original.status).toBe('Submitted');
    expect(original.version).toBe(1);
    expect(original.history).toHaveLength(1);
  });
});
