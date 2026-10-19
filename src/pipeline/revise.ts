import type { Evidence } from "../schemas/evidence";
import type {
  Critique,
  EventRow,
  GapItem,
  Report,
  RoundCritique,
  TagInventoryItem,
  TrackingPlanRow,
} from "../schemas/report";
import { isReservedEventName, toConvention } from "./convention";
import type { RunStore } from "../store";
import { buildEventRows } from "./synthesize";

/**
 * Revision engine: apply ONLY Jev-Correct critiques, deterministically, with
 * a re-check against the evidence. When the deterministic re-check
 * contradicts the critique, the affected report item is shipped with an
 * explicit contested flag rather than dropped or silently changed.
 */

export interface RevisionOutcome {
  revised: Report;
  applied: { critiqueId: string; targetRef: string; fix: string }[];
  contested: string[];
}

type EventRowTarget = { kind: "events"; row: EventRow };
type GapTarget = { kind: "gaps"; row: GapItem };
type PlanTarget = { kind: "plan"; row: TrackingPlanRow };
type TagTarget = { kind: "tags"; row: TagInventoryItem };
type Target = EventRowTarget | GapTarget | PlanTarget | TagTarget;

export function applyCritiques(
  draft: Report,
  critiques: Critique[],
  store: RunStore,
): RevisionOutcome {
  const applied: { critiqueId: string; targetRef: string; fix: string }[] = [];
  const contested: string[] = [];
  const revised: Report = {
    ...draft,
    events: [...draft.events],
    gaps: [...draft.gaps],
    trackingPlan: [...draft.trackingPlan],
    recommendations: [...draft.recommendations],
    tagInventory: [...draft.tagInventory],
  };
  const evidence = store.listEvidence();

  for (const critique of critiques) {
    const target = findTarget(revised, critique.targetRef, evidence);
    if (!target && critique.type !== "wrong_recommendation") {
      applied.push({
        critiqueId: critique.id,
        targetRef: critique.targetRef,
        fix: "target row not found; no change",
      });
      continue;
    }
    switch (critique.type) {
      case "hallucinated_event": {
        if (!target || target.kind !== "events") {
          contested.push(critique.targetRef);
          break;
        }
        // Re-check: does the row's cited evidence actually show the event?
        const supported = target.row.evidenceIds.some((id) =>
          evidenceShowsEvent(evidence, id, target.row.eventName),
        );
        if (!supported) {
          revised.events = revised.events.filter((r) => r !== target.row);
          applied.push({
            critiqueId: critique.id,
            targetRef: critique.targetRef,
            fix: `dropped event row ${target.row.eventName} (cited evidence does not show it)`,
          });
        } else {
          target.row.contested = true;
          contested.push(critique.targetRef);
        }
        break;
      }
      case "missed_event": {
        const added: string[] = [];
        for (const id of critique.citedEvidenceIds) {
          const e = evidence.find((x) => x.id === id);
          if (!e || e.kind !== "beacon" || typeof e.payload.eventName !== "string") continue;
          const dest = e.dest ?? "other";
          const exists = revised.events.some(
            (r) => r.eventName === e.payload.eventName && r.destinations.includes(dest as never),
          );
          if (exists) continue;
          const rows = buildEventRows(store).filter(
            (r) => r.eventName === e.payload.eventName && r.destinations.includes(dest as never),
          );
          for (const row of rows) {
            revised.events.push(row);
            applied.push({
              critiqueId: critique.id,
              targetRef: critique.targetRef,
              fix: `added event row ${row.eventName} (${row.interaction}) from evidence ${id}`,
            });
            added.push(row.eventName);
          }
        }
        if (added.length === 0) {
          contested.push(critique.targetRef);
          applied.push({
            critiqueId: critique.id,
            targetRef: critique.targetRef,
            fix: "cited evidence adds no missing event row; marked contested",
          });
        }
        break;
      }
      case "misclassified_destination": {
        if (!target || target.kind !== "events") {
          contested.push(critique.targetRef);
          break;
        }
        const e = evidence.find((x) => critique.citedEvidenceIds.includes(x.id));
        if (e && e.dest) {
          const before = target.row.destinations.join("+");
          target.row.destinations = [...new Set([...target.row.destinations, e.dest])].sort() as typeof target.row.destinations;
          applied.push({
            critiqueId: critique.id,
            targetRef: critique.targetRef,
            fix: `destination for ${target.row.eventName}: ${before} -> ${target.row.destinations.join("+")} (evidence ${e.id})`,
          });
        } else {
          contested.push(critique.targetRef);
        }
        break;
      }
      case "misclassified_interaction": {
        if (!target || target.kind !== "events") {
          contested.push(critique.targetRef);
          break;
        }
        const e = evidence.find((x) => critique.citedEvidenceIds.includes(x.id));
        if (e) {
          const from = target.row.interaction;
          target.row.interaction = store.interactionFor(e) as typeof target.row.interaction;
          applied.push({
            critiqueId: critique.id,
            targetRef: critique.targetRef,
            fix: `interaction for ${target.row.eventName}: ${from} -> ${target.row.interaction} (evidence ${e.id})`,
          });
        } else {
          contested.push(critique.targetRef);
        }
        break;
      }
      case "convention_violation": {
        if (!target || target.kind !== "plan") {
          contested.push(critique.targetRef);
          break;
        }
        if (!isReservedEventName(target.row.proposedName)) {
          const fixed = toConvention(target.row.proposedName, revised.convention.style);
          target.row.proposedName = fixed;
          target.row.rationale = `${target.row.rationale} (proposedName re-fixed to ${revised.convention.style})`.slice(0, 300);
          applied.push({
            critiqueId: critique.id,
            targetRef: critique.targetRef,
            fix: `plan proposedName re-fixed to follow ${revised.convention.style}: ${fixed}`,
          });
        } else {
          contested.push(critique.targetRef);
        }
        break;
      }
      case "wrong_recommendation": {
        if (target?.kind === "plan") {
          const idx = revised.trackingPlan.indexOf(target.row);
          if (idx >= 0) {
            revised.trackingPlan.splice(idx, 1);
            applied.push({
              critiqueId: critique.id,
              targetRef: critique.targetRef,
              fix: `removed plan row ${critique.targetRef} (contradicted by evidence)`,
            });
            break;
          }
        }
        // Recommendation refs: "recs:<i>" or "recommendations:<i>".
        const recMatch = /^(?:recs|recommendations):(\d+)$/.exec(critique.targetRef);
        if (recMatch) {
          const recIdx = Number(recMatch[1]);
          if (recIdx < revised.recommendations.length) {
            const [removed] = revised.recommendations.splice(recIdx, 1);
            applied.push({
              critiqueId: critique.id,
              targetRef: critique.targetRef,
              fix: `removed recommendation: ${removed.slice(0, 120)}`,
            });
          } else {
            contested.push(critique.targetRef);
          }
        } else {
          contested.push(critique.targetRef);
        }
        break;
      }
      default: {
        contested.push(critique.targetRef);
        break;
      }
    }
  }

  // Sort events deterministically again after revisions.
  revised.events = [...revised.events].sort(
    (a, b) => a.eventName.localeCompare(b.eventName) || a.interaction.localeCompare(b.interaction),
  );
  revised.contestedRefs = [...new Set([...draft.contestedRefs, ...contested])];
  return { revised, applied, contested };
}

function findTarget(report: Report, targetRef: string, evidence: Evidence[]): Target | null {
  const colonAt = targetRef.indexOf(":");
  const [kindRaw, rest] = colonAt < 0 ? ["", ""] : [targetRef.slice(0, colonAt), targetRef.slice(colonAt + 1)];
  // Reviewers occasionally write "recommendations"/"recs" interchangeably.
  const kind = kindRaw === "recommendations" ? "recs" : kindRaw;
  if (kind === "events") {
    const at = rest.indexOf("@");
    const name = at < 0 ? rest : rest.slice(0, at);
    const dests = at < 0 ? "" : rest.slice(at + 1);
    const row = report.events.find(
      (r) => r.eventName === name && (dests === "" || r.destinations.join("+") === dests),
    );
    return row ? { kind: "events", row } : null;
  }
  if (kind === "gaps") {
    const row = report.gaps[Number(rest)];
    return row ? { kind: "gaps", row } : null;
  }
  if (kind === "plan") {
    const row = report.trackingPlan[Number(rest)];
    return row ? { kind: "plan", row } : null;
  }
  if (kind === "tags") {
    const row = report.tagInventory[Number(rest)];
    return row ? { kind: "tags", row } : null;
  }
  void evidence;
  return null;
}

function evidenceShowsEvent(evidence: Evidence[], id: string, eventName: string): boolean {
  const e = evidence.find((x) => x.id === id);
  return !!e && e.payload.eventName === eventName;
}

/** Round summary rows for the appendix. */
export function roundCritiqueRows(
  critiques: Critique[],
  gradings: Map<string, { verdict: string; confidence: number; flagged: boolean }>,
): RoundCritique[] {
  return critiques.map((c) => {
    const g = gradings.get(c.id);
    return {
      id: c.id,
      targetRef: c.targetRef,
      claim: c.claim.slice(0, 240),
      verdict: (g?.verdict ?? "Ungraded") as "Correct" | "Partially Correct" | "Incorrect",
      confidence: g?.confidence ?? 0,
      propagated: g?.verdict === "Correct",
      flagged: g?.flagged ?? false,
    };
  });
}
