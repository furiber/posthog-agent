import { isReservedEventName, toConvention, conformsTo } from "./convention";
import type { Report } from "../schemas/report";
import type { RunStore } from "../store";

/**
 * Final gate: every claim must carry at least one EXISTING evidence ID, and
 * the naming table must pass the derived (or default) convention check.
 * Violations are fixed mechanically or flagged, never silently shipped.
 */

export interface GateResult {
  report: Report;
  notes: string[];
}

const INTERACTION_OBJECT: Record<string, string> = {
  click: "cta",
  form_submit: "form",
  consent_toggle: "consent",
  load: "page",
  other: "site",
};

export function finalGate(report: Report, store: RunStore): GateResult {
  const notes: string[] = [];
  const known = new Set(store.listEvidence().map((e) => e.id));
  const hasEvidence = (ids: string[]) => ids.some((id) => known.has(id));

  // 1. Every claim row carries >=1 existing evidence ID.
  const beforeEvents = report.events.length;
  report.events = report.events.filter((r) => {
    if (!hasEvidence(r.evidenceIds)) {
      notes.push(`dropped event row ${r.eventName}: no existing evidence ID`);
      return false;
    }
    return true;
  });
  report.tagInventory = report.tagInventory.filter((r) => {
    if (!hasEvidence(r.evidenceIds)) {
      notes.push(`dropped tag row: no existing evidence ID`);
      return false;
    }
    return true;
  });
  report.gaps = report.gaps.filter((r) => {
    if (!hasEvidence(r.evidenceIds)) {
      notes.push(`dropped gap "${r.title}": no existing evidence ID`);
      return false;
    }
    return true;
  });
  const beforePlan = report.trackingPlan.length;
  report.trackingPlan = report.trackingPlan.filter((r) => {
    if (!hasEvidence(r.evidenceIds)) {
      notes.push(`dropped plan row ${r.proposedName}: no existing evidence ID`);
      return false;
    }
    return true;
  });
  if (beforeEvents !== report.events.length || beforePlan !== report.trackingPlan.length) {
    report.partial = true;
  }

  // 2. The naming table passes the convention check (auto-fixed when mechanical).
  for (const row of report.trackingPlan) {
    if (isReservedEventName(row.proposedName)) continue; // platform-locked
    if (conformsTo(row.proposedName, report.convention.style)) continue;
    let fixed = toConvention(row.proposedName, report.convention.style);
    if (!conformsTo(fixed, report.convention.style) && row.action === "add") {
      // A single token cannot become object_action mechanically; prefix the
      // interaction object (e.g. add "signup" on form_submit -> "form_signup").
      const object = INTERACTION_OBJECT[row.interaction] ?? "site";
      fixed = toConvention(`${object}_${row.proposedName}`, report.convention.style);
    }
    if (conformsTo(fixed, report.convention.style) && fixed !== row.currentName) {
      notes.push(`plan row renamed at the gate for convention: "${row.proposedName}" -> "${fixed}"`);
      row.proposedName = fixed;
    } else {
      notes.push(`plan row "${row.proposedName}" does not follow ${report.convention.style} and could not be auto-fixed; flagged contested`);
      row.contested = true;
      if (!report.contestedRefs.includes(`plan:${row.proposedName}`)) {
        report.contestedRefs.push(`plan:${row.proposedName}`);
      }
    }
  }

  // 3. Diffable methods: keep rows identical, rename rows different.
  report.trackingPlan = report.trackingPlan.filter((r) => {
    if (r.action === "keep" && r.currentName !== r.proposedName) {
      notes.push(`dropped keep row ${r.currentName}: current and proposed differ`);
      return false;
    }
    if (r.action === "rename" && r.currentName === r.proposedName) {
      notes.push(`dropped rename row ${r.currentName}: no diff`);
      return false;
    }
    return true;
  });

  // 4. The Jev round log is part of the shipped report (appendix data).
  if (report.jevRounds.length === 0) {
    notes.push("no validation rounds recorded");
  }

  return { report, notes };
}
