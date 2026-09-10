import { describe, it, expect } from 'vitest';
import { renderSlaInApp, renderSlaEmail } from './templates.js';
import type { RecipientContact } from '../../notifications/domain/value-objects.js';

/**
 * Unit tests for the SLA notice templates (`business-rules` `BR-PII-1/2`). The
 * in-app copy is built from PII-free fields only; the email greeting may use a
 * display name (transient PII), never a raw email or free-text reason.
 */

describe('renderSlaInApp (BR-PII-1)', () => {
  it('renders a PII-free reminder headline referencing the request id', () => {
    const rendered = renderSlaInApp('req-1', 'TeamLead', 'Reminder');
    expect(rendered.title).toContain('Reminder');
    expect(rendered.title).toContain('team lead');
    expect(rendered.body).toContain('request req-1');
  });

  it('renders an escalation headline for a breached HR-stage request', () => {
    const rendered = renderSlaInApp('req-2', 'HR', 'Escalation');
    expect(rendered.title).toContain('breached SLA');
    expect(rendered.title).toContain('HR approval');
  });

  it('never embeds an email or contact detail in the in-app body', () => {
    const rendered = renderSlaInApp('req-9', 'TeamLead', 'Escalation');
    expect(rendered.body).not.toContain('@');
  });
});

describe('renderSlaEmail (BR-PII-2)', () => {
  it('greets with the display name when present', () => {
    const contact: RecipientContact = { principalId: 'lead-1', email: 'lead@corp.example', displayName: 'Liam' };
    const rendered = renderSlaEmail('req-1', 'TeamLead', 'Reminder', contact);
    expect(rendered.body).toContain('Hello Liam,');
    expect(rendered.subject).toContain('Reminder');
  });

  it('falls back to a generic greeting without a display name', () => {
    const contact: RecipientContact = { principalId: 'lead-1', email: 'lead@corp.example' };
    const rendered = renderSlaEmail('req-1', 'HR', 'Escalation', contact);
    expect(rendered.body).toContain('Hello,');
    expect(rendered.subject).toContain('breached SLA');
  });
});
