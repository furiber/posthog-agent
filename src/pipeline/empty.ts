import type { Report } from "../schemas/report";

const NOTE =
  "Detection inconclusive: no analytics tags or beacons were recognised on the visited pages. Possible causes: tags that load only after a click or consent, a login wall, a renamed or proxied loader the detector does not recognise, or a site with no analytics. No recommendations are made without evidence.";

/**
 * F7: a deterministic report with no tags and no events must not go through the
 * model pipeline (it would invent fixes). Returns the honest empty-state report,
 * or null when something was detected and the normal pipeline should run.
 */
export function asEmptyDetectionReport(report: Report): Report | null {
  if (report.tagInventory.length > 0 || report.events.length > 0) return null;
  return {
    ...report,
    gaps: [],
    recommendations: [],
    trackingPlan: [],
    jevRounds: [],
    contestedRefs: [],
    outcome: "no_analytics_detected",
    detectionNote: NOTE,
  };
}
