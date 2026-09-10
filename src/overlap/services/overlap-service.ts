/**
 * `OverlapService` — the read-side projection for unit-overlap-indicator.
 *
 * Realizes the single owned story `story-overlap-indicator` / requirement
 * `req-overlap-indicator`: given a request under review, tell the reviewing
 * team lead how many other in-scope team requests overlap the requested range.
 *
 * This is a PURE, STATELESS projection over data unit-request-workflow already
 * owns (business-logic-model Design Approach). It introduces no new aggregate
 * and no new persistence: it reads the department's requests through the
 * workflow's `VacationRequestRepository` read seam (`findById`,
 * `findByDepartmentAndStatus`) and computes overlap using the shipped pure
 * primitive `rangesOverlap` — never re-deriving date math (INV-OV-3).
 *
 * Posture (business-rules):
 *   - BR-ADV-1  read-only: no writes, no emitted events, no transition verbs.
 *   - BR-ADV-3  fail-open: an expected read failure is returned as
 *               `err(OverlapError)`, never thrown; callers degrade to
 *               "overlap unavailable".
 *   - BR-OV-6   idempotent + side-effect-free.
 *
 * Authorization is NOT re-derived here (BR-SCOPE-1): the service is invoked only
 * behind the shared `requireSession -> requirePermission('request:validate')`
 * pipeline that guards the lead review path. The comparison set's department
 * follows the reviewed request (BR-SCOPE-2).
 *
 * PII (`req-nfr-security-pii`, BR-PII-1..3): the summary carries counts and
 * opaque `RequestId`s only; errors carry a machine-readable code only.
 */

import { type Result, ok, err } from '../../domain/result.js';
import {
  type RequestId,
  type VacationRequestRepository,
  rangesOverlap,
} from '../../workflow/index.js';
import { COMPETING_STATUSES, type OverlapSummary } from '../domain/value-objects.js';
import { OverlapError } from '../domain/overlap-error.js';
import type { OverlapReader } from '../ports/overlap-reader.js';

export interface OverlapServiceDeps {
  /** The workflow's read seam, consumed read-only (INV-OV-1, BR-ADV-1). */
  readonly repository: VacationRequestRepository;
}

export class OverlapService implements OverlapReader {
  private readonly repository: VacationRequestRepository;

  constructor(deps: OverlapServiceDeps) {
    this.repository = deps.repository;
  }

  /**
   * Compute the advisory overlap summary for the request under review.
   *
   * Steps (business-logic-model `computeOverlap`):
   *   1. load R by id                          -> notFound (advisory) if unknown
   *   2. gather candidates for R.department across the competing statuses
   *   3. keep c where c.id != R.id AND rangesOverlap(R.dates, c.dates)  [BR-OV-1..4]
   *   4. build the PII-free summary                                     [BR-OV-5/PII]
   *
   * Read-seam errors are caught and mapped to `err(READ_FAILED)` (BR-ADV-3) so
   * the fail-open contract holds even if a durable adapter throws.
   */
  async computeOverlap(requestId: RequestId): Promise<Result<OverlapSummary, OverlapError>> {
    try {
      const reviewed = await this.repository.findById(requestId);
      if (reviewed === null) return err(OverlapError.notFound());

      const window = reviewed.department;
      // Gather competing candidates across every status that reserves coverage
      // (BR-OV-3). Reuse the shipped read seam verbatim — one scoped read per
      // status — rather than widening the dependency unit's port (BR-OV-2).
      const candidateGroups = await Promise.all(
        COMPETING_STATUSES.map((status) =>
          this.repository.findByDepartmentAndStatus(window, status),
        ),
      );

      const reviewedDates = reviewed.toState().dates;
      const overlappingIds: RequestId[] = [];
      for (const group of candidateGroups) {
        for (const candidate of group) {
          if (candidate.id === reviewed.id) continue; // BR-OV-4: no self-overlap
          if (rangesOverlap(reviewedDates, candidate.toState().dates)) {
            overlappingIds.push(candidate.id); // BR-OV-1: intersection is the sole test
          }
        }
      }

      const summary: OverlapSummary = {
        overlappingIds,
        overlapCount: overlappingIds.length, // BR-OV-5
        hasOverlap: overlappingIds.length > 0, // BR-OV-5
        window: reviewedDates, // echoed for the badge tooltip
      };
      return ok(summary);
    } catch {
      // BR-ADV-3: fail-open — never let a read-seam fault propagate into or
      // block the workflow command path. PII-free code only (BR-PII-3).
      return err(OverlapError.readFailed());
    }
  }
}
