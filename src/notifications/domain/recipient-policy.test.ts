import { describe, it, expect } from 'vitest';
import { recipientsFor, DEFAULT_RECIPIENT_POLICY } from './recipient-policy.js';
import type {
  RequestSubmitted,
  RequestValidated,
  RequestApproved,
  RequestRejected,
  RequestWithdrawn,
} from '../../workflow/domain/events.js';

/**
 * Unit tests for the pure recipient policy (business-rules `BR-NOTIF-1..5`):
 * the event → recipient-set mapping with no I/O.
 */

const base = {
  requestId: 'req-1',
  ownerId: 'emp-1',
  department: 'engineering',
  actorId: 'actor-1',
  atMs: 1000,
} as const;

const submitted: RequestSubmitted = { ...base, type: 'RequestSubmitted', status: 'Submitted' };
const validated: RequestValidated = { ...base, type: 'RequestValidated', status: 'Validated' };
const approved: RequestApproved = { ...base, type: 'RequestApproved', status: 'Approved' };
const rejected: RequestRejected = { ...base, type: 'RequestRejected', status: 'Rejected', rejectedStage: 'HR' };
const withdrawn: RequestWithdrawn = { ...base, type: 'RequestWithdrawn', status: 'Withdrawn' };

describe('recipientsFor — BR-NOTIF-1..5', () => {
  it('RequestSubmitted → owner (required) + team lead of department (BR-NOTIF-3)', () => {
    const r = recipientsFor(submitted);
    expect(r).toContainEqual({ kind: 'principal', principalId: 'emp-1', required: true });
    expect(r).toContainEqual({ kind: 'role', role: 'team-lead', department: 'engineering', required: true });
  });

  it('RequestValidated → owner + HR of department (BR-NOTIF-3)', () => {
    const r = recipientsFor(validated);
    expect(r).toContainEqual({ kind: 'role', role: 'hr', department: 'engineering', required: true });
  });

  it('terminal events notify only the owner by default (BR-NOTIF-5)', () => {
    expect(recipientsFor(approved)).toEqual([{ kind: 'principal', principalId: 'emp-1', required: true }]);
    expect(recipientsFor(rejected)).toEqual([{ kind: 'principal', principalId: 'emp-1', required: true }]);
    expect(recipientsFor(withdrawn)).toEqual([{ kind: 'principal', principalId: 'emp-1', required: true }]);
  });

  it('copies the actor on terminal events when configured (BR-NOTIF-5)', () => {
    const r = recipientsFor(approved, { ...DEFAULT_RECIPIENT_POLICY, copyActorOnTerminal: true });
    expect(r).toContainEqual({ kind: 'principal', principalId: 'actor-1', required: false });
  });

  it('copies the team lead on withdrawal when configured (BR-NOTIF-5)', () => {
    const r = recipientsFor(withdrawn, { ...DEFAULT_RECIPIENT_POLICY, copyLeadOnWithdrawn: true });
    expect(r).toContainEqual({ kind: 'role', role: 'team-lead', department: 'engineering', required: false });
  });

  it('the owner is always a required recipient (BR-NOTIF-2)', () => {
    for (const event of [submitted, validated, approved, rejected, withdrawn]) {
      const owner = recipientsFor(event).find((t) => t.kind === 'principal' && t.principalId === 'emp-1');
      expect(owner?.required).toBe(true);
    }
  });

  it('an unknown event type maps to no recipients (fail-closed)', () => {
    const unknown = { ...submitted, type: 'Nope' } as unknown as RequestSubmitted;
    expect(recipientsFor(unknown)).toEqual([]);
  });
});
