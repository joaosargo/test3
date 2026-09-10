import { describe, it, expect } from 'vitest';
import { renderInApp, renderEmail } from './templates.js';
import { deriveDedupeKey } from './value-objects.js';
import type { RequestApproved, RequestRejected } from '../../workflow/domain/events.js';

/**
 * Unit tests for template rendering and the dedupe-key derivation
 * (business-logic-model render step; business-rules `BR-NOTIF-9`, `BR-PII-1`).
 */

const approved: RequestApproved = {
  type: 'RequestApproved',
  requestId: 'req-42',
  ownerId: 'emp-1',
  department: 'engineering',
  actorId: 'hr-1',
  status: 'Approved',
  atMs: 1000,
};

const rejected: RequestRejected = {
  type: 'RequestRejected',
  requestId: 'req-42',
  ownerId: 'emp-1',
  department: 'engineering',
  actorId: 'lead-1',
  status: 'Rejected',
  rejectedStage: 'HR',
  atMs: 1000,
};

describe('renderInApp — PII-free (BR-PII-1)', () => {
  it('renders a headline referencing the request id only', () => {
    const r = renderInApp(approved);
    expect(r.title).toBe('Vacation request approved');
    expect(r.body).toContain('req-42');
  });

  it('embeds the rejection stage in the title', () => {
    expect(renderInApp(rejected).title).toContain('HR');
  });
});

describe('renderEmail', () => {
  it('greets by display name when present and keeps content PII-minimal', () => {
    const r = renderEmail(approved, { principalId: 'emp-1', email: 'e@corp.example', displayName: 'Emma' });
    expect(r.subject).toBe('Vacation request approved');
    expect(r.body).toContain('Hello Emma,');
  });

  it('falls back to a generic greeting when no display name is resolved', () => {
    const r = renderEmail(approved, { principalId: 'emp-1', email: 'e@corp.example' });
    expect(r.body).toContain('Hello,');
  });
});

describe('deriveDedupeKey — BR-NOTIF-9', () => {
  it('is deterministic for the same (requestId, eventType, atMs)', () => {
    expect(deriveDedupeKey('req-1', 'RequestSubmitted', 1000)).toBe(
      deriveDedupeKey('req-1', 'RequestSubmitted', 1000),
    );
  });

  it('differs when any component differs', () => {
    const a = deriveDedupeKey('req-1', 'RequestSubmitted', 1000);
    expect(deriveDedupeKey('req-2', 'RequestSubmitted', 1000)).not.toBe(a);
    expect(deriveDedupeKey('req-1', 'RequestApproved', 1000)).not.toBe(a);
    expect(deriveDedupeKey('req-1', 'RequestSubmitted', 2000)).not.toBe(a);
  });
});
