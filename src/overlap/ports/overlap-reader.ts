/**
 * `OverlapReader` inbound (driving) port for unit-overlap-indicator.
 *
 * The single capability the unit exposes (matches `component-methods`
 * `overlap-indicator` and domain-entities `OverlapReader`): compute the
 * advisory overlap summary for a request under review.
 *
 * There is NO outbound port unique to this unit — its only outbound dependency
 * is the CONSUMED `VacationRequestRepository` read seam owned by
 * unit-request-workflow. The unit deliberately holds no repository, no cache,
 * and no event publisher of its own (contrast the command-path units),
 * reflecting its stateless read-side nature (per `services`).
 */

import type { Result } from '../../domain/result.js';
import type { RequestId } from '../../workflow/index.js';
import type { OverlapSummary } from '../domain/value-objects.js';
import type { OverlapError } from '../domain/overlap-error.js';

export interface OverlapReader {
  /**
   * Compute the advisory overlap summary for a request under review.
   * Idempotent and side-effect-free (BR-OV-6): repeated calls over fixed
   * underlying state return the same summary and mutate nothing.
   */
  computeOverlap(requestId: RequestId): Promise<Result<OverlapSummary, OverlapError>>;
}
