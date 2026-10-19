import type { Report } from "../schemas/report";

/** Render the five-section report + appendices as markdown. */
export function renderMarkdown(report: Report): string {
  const L: string[] = [];
  const contested = (flag?: boolean) => (flag ? " ⚠️**contested**" : "");

  L.push(`# Analytics instrumentation audit — ${report.site}`);
  L.push("");
  L.push(`> Run \`${report.runId}\` · started ${report.startedAt} · page budget ${report.pageBudget} · pages visited ${report.pagesVisited.length}${report.pagesFailed.length > 0 ? ` · pages failed ${report.pagesFailed.length}` : ""}`);
  L.push(`> Models: crawler \`${report.models.crawler}\`, synthesizer \`${report.models.synthesizer}\`, adversarial reviewer \`${report.models.reviewer}\`, Jev grader \`${report.models.jev}\``);
  if (report.partial || report.budgetExhausted || report.error) {
    L.push(`> ⚠️ **Partial run**${report.budgetExhausted ? " — a budget was exhausted; findings cover the evidence gathered so far" : ""}${report.error ? ` — ${report.error}` : ""}`);
  }
  L.push("");

  L.push(`## 1. Tag inventory`);
  L.push("");
  if (report.tagInventory.length === 0) {
    L.push("_No analytics tags found on any visited page._");
  } else {
    L.push("| Destination | Injected via | Location | Detail | Evidence |");
    L.push("|---|---|---|---|---|");
    for (const t of report.tagInventory) {
      L.push(`| ${t.destination}${contested(t.contested)} | ${esc(t.injectedVia)} | ${esc(t.location)} | ${esc(t.detail)} | ${t.evidenceIds.slice(0, 3).join(", ")} |`);
    }
  }
  L.push("");

  L.push(`## 2. Events & interactions`);
  L.push("");
  L.push("_A naming-conventions table of all events sent through and the interactions when they occur._");
  L.push("");
  if (report.events.length === 0) {
    L.push("_No analytics events were observed on the wire._");
  } else {
    L.push("| Event | Destinations | Interaction (when it occurs) | Observed on | Properties | Evidence |");
    L.push("|---|---|---|---|---|---|");
    for (const e of report.events) {
      L.push(
        `| \`${esc(e.eventName)}\`${contested(e.contested)} | ${e.destinations.join(", ")} | ${e.interaction} | ${e.observedOn.slice(0, 2).map((u) => esc(shortUrl(u))).join("<br>")}${e.observedOn.length > 2 ? ` +${e.observedOn.length - 2} more` : ""} | ${e.properties.slice(0, 6).map(esc).join(", ") || "—"} | ${e.evidenceIds.slice(0, 3).join(", ")} |`,
      );
    }
  }
  L.push("");

  L.push(`## 3. Naming conventions`);
  L.push("");
  const c = report.convention;
  L.push(
    `- **Event style:** ${c.isDefault ? "_none discernible — default applied_ → " : ""}\`${c.style}\` — ${c.eventPattern}${contested(report.contestedRefs.includes("convention"))}`,
  );
  L.push(`- **Property style:** \`${c.propertyStyle}\``);
  L.push(`- **Derived from:** ${esc(c.derivedFrom)} (confidence ${(c.confidence * 100).toFixed(0)}%)`);
  L.push(`- ${esc(c.ga4Note)}`);
  L.push("");

  L.push(`## 4. Gaps & misconfigurations`);
  L.push("");
  if (report.gaps.length === 0) {
    L.push("_No gaps detected from the captured evidence._");
  } else {
    L.push("| Severity | Gap | Detail | Evidence |");
    L.push("|---|---|---|---|");
    for (const g of report.gaps) {
      L.push(`| ${g.severity.toUpperCase()}${contested(g.contested)} | ${esc(g.title)} | ${esc(g.detail)} | ${g.evidenceIds.slice(0, 3).join(", ")} |`);
    }
  }
  L.push("");

  L.push(`## 5. Recommendations`);
  L.push("");
  if (report.recommendations.length > 0) {
    for (const r of report.recommendations) {
      L.push(`- ${esc(r)}`);
    }
    L.push("");
  }
  if (report.trackingPlan.length === 0) {
    L.push("_No tracking plan proposed (insufficient evidence, or the plan step failed)._");
  } else {
    L.push("### Tracking plan (diffable: current → proposed)");
    L.push("");
    L.push("| Action | Current | Proposed | Destination | Interaction | Properties | Priority | Rationale | Evidence |");
    L.push("|---|---|---|---|---|---|---|---|---|");
    for (const p of report.trackingPlan) {
      L.push(
        `| ${p.action}${contested(p.contested)} | ${p.currentName ? `\`${esc(p.currentName)}\`` : "—"} | \`${esc(p.proposedName)}\` | ${p.destination} | ${p.interaction} | ${p.properties.slice(0, 5).map(esc).join(", ") || "—"} | ${p.priority} | ${esc(p.rationale)} | ${p.evidenceIds.slice(0, 3).join(", ")} |`,
      );
    }
    L.push("");
    L.push("Priority order: " + report.trackingPlan.map((p) => p.priority).sort().join(" → ") + " (P0 first).");
  }
  L.push("");

  L.push(`## Appendix A. Jev validation log`);
  L.push("");
  if (report.jevRounds.length === 0) {
    L.push("_No validation rounds ran._");
  } else {
    for (const round of report.jevRounds) {
      L.push(`### Round ${round.round} — ${round.critiqueCount} critique(s), ${round.propagated} Jev-Correct (propagated)`);
      L.push("");
      if (round.critiques.length === 0) {
        L.push("_Reviewer raised no critiques._");
      } else {
        L.push("| ID | Target | Critique | Jev verdict | Confidence | Propagated |");
        L.push("|---|---|---|---|---|---|");
        for (const k of round.critiques) {
          L.push(
            `| ${k.id} | ${esc(k.targetRef)} | ${esc(k.claim)} | ${k.verdict} | ${k.confidence.toFixed(2)}${k.flagged ? " ⚠️<0.7" : ""} | ${k.propagated ? "yes" : "no"} |`,
          );
        }
      }
      L.push("");
    }
  }

  if (report.contestedRefs.length > 0) {
    L.push(`## Appendix B. Contested items (shipped, not dropped)`);
    L.push("");
    for (const ref of report.contestedRefs) {
      L.push(`- ${esc(ref)} — Jev-Correct critique could not be resolved against the evidence; the item ships with an explicit contested flag.`);
    }
    L.push("");
  }

  if (report.partial || report.error) {
    L.push(`## Appendix C. Partial-evidence error report`);
    L.push("");
    L.push(`- partial: ${report.partial}`);
    L.push(`- budgetExhausted: ${report.budgetExhausted ?? false}`);
    L.push(`- error: ${report.error ?? "—"}`);
    L.push("");
  }

  return L.join("\n");
}

function esc(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);
}

function shortUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return parsed.pathname === "/" ? parsed.hostname : `${parsed.hostname}${parsed.pathname}`.slice(0, 60);
  } catch {
    return u.slice(0, 60);
  }
}
