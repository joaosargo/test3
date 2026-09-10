/**
 * Client helper for unit-overlap-indicator — the team-lead overlap badge.
 *
 * Realizes `story-overlap-indicator`. This is the `useOverlapSummary(requestId)`
 * data hook + `<OverlapIndicatorBadge>` rendering described in
 * frontend-components, expressed as a tiny framework-free module that the
 * `unit-request-workflow`-owned `<RequestReviewCard>` can call to populate its
 * reserved `[data-testid="overlap-indicator-badge"]` slot.
 *
 * Design principles (frontend-components):
 *   - Advisory, never a gate: this helper only renders a chip; it NEVER
 *     disables or gates the sibling Validate/Reject controls (BR-ADV-2).
 *   - Server-authoritative: it renders exactly what `GET /requests/:id/overlap`
 *     returns and performs no client-side authorization/scope filtering.
 *   - Fail-open: any non-200 / network error renders a neutral
 *     "overlap unavailable" chip — never an error that looks like a block
 *     (BR-ADV-3).
 *   - PII-free: shows a count and severity only, never owner names/emails
 *     (BR-PII-1/2).
 */

/**
 * Fetch the advisory overlap summary for a request under review.
 * Fail-open (BR-ADV-3): returns `{ unavailable: true }` on any error — it never
 * throws into the caller.
 *
 * @param {string} requestId
 * @returns {Promise<{ summary?: OverlapSummary, unavailable?: boolean }>}
 */
export async function fetchOverlapSummary(requestId) {
  try {
    const res = await fetch(`/requests/${encodeURIComponent(requestId)}/overlap`);
    if (res.status !== 200) return { unavailable: true };
    const summary = await res.json();
    return { summary };
  } catch {
    return { unavailable: true };
  }
}

/**
 * Render the overlap badge into a target element (the reserved
 * `overlap-indicator-badge` slot on the review card).
 *
 * @param {HTMLElement} el   the badge slot element
 * @param {{ summary?: OverlapSummary, loading?: boolean, unavailable?: boolean }} viewState
 */
export function renderOverlapBadge(el, viewState) {
  if (!el) return;
  el.dataset.testid = el.dataset.testid || 'overlap-indicator-badge';

  if (viewState.loading) {
    el.textContent = 'Checking overlap…';
    el.setAttribute('data-overlap-state', 'loading');
    return;
  }
  if (viewState.unavailable || !viewState.summary) {
    // Fail-open neutral chip — must not look like a blocked decision (BR-ADV-3).
    el.textContent = 'Overlap unavailable';
    el.setAttribute('data-overlap-state', 'unavailable');
    return;
  }

  const { hasOverlap, overlapCount, window } = viewState.summary;
  if (!hasOverlap) {
    el.textContent = 'No overlap';
    el.setAttribute('data-overlap-state', 'none');
  } else {
    el.textContent = `${overlapCount} overlapping`;
    el.setAttribute('data-overlap-state', 'overlap');
    // Tooltip lists the reviewed window and the count only — ids stay opaque,
    // no PII (BR-PII-1/2).
    if (window && window.startDate && window.endDate) {
      el.title = `${overlapCount} other request(s) overlap ${window.startDate} → ${window.endDate}`;
    }
  }
}

/**
 * Convenience wire-up used by the lead review card: fetch then render, showing
 * the loading state first. Always resolves (fail-open); never rejects.
 *
 * @param {HTMLElement} el
 * @param {string} requestId
 */
export async function mountOverlapBadge(el, requestId) {
  renderOverlapBadge(el, { loading: true });
  const viewState = await fetchOverlapSummary(requestId);
  renderOverlapBadge(el, viewState);
}

/**
 * @typedef {Object} OverlapSummary
 * @property {boolean} hasOverlap
 * @property {number} overlapCount
 * @property {string[]} overlappingIds
 * @property {{ startDate: string, endDate: string }} window
 */
