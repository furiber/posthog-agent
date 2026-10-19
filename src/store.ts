import type { Evidence, EvidenceKind, EvidenceSource, InteractionKind, Destination } from "./schemas/evidence";

/**
 * Append-only evidence store + run log over the Durable Object's SQLite
 * storage. Every beacon/snippet gets an evidence ID; no claim may exist
 * without one. One DO instance per run, so all rows belong to this run.
 */

type SqlExec = (
  query: string,
  ...params: (string | number | null)[]
) => { toArray: () => Record<string, unknown>[]; one: () => Record<string, unknown> };

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  site TEXT NOT NULL,
  page_url TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  dest TEXT,
  capture_id TEXT,
  interaction_step_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_capture ON evidence(capture_id);
CREATE TABLE IF NOT EXISTS run_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS reports (
  run_id TEXT PRIMARY KEY,
  markdown TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export class RunStore {
  readonly runId: string;
  readonly site: string;
  private seq: number;

  constructor(
    private sql: { exec: SqlExec },
    runId: string,
    site: string,
  ) {
    this.runId = runId;
    this.site = site;
    const row = this.sql.exec("SELECT COUNT(*) AS n FROM evidence").one();
    this.seq = Number(row.n ?? 0);
  }

  private nextId(): string {
    this.seq += 1;
    return `E${String(this.seq).padStart(6, "0")}`;
  }

  /** Append an evidence entry; dedupes on captureId. Returns the stored entry. */
  appendEvidence(input: {
    pageUrl: string;
    timestamp: string;
    kind: EvidenceKind;
    source: EvidenceSource;
    dest?: Destination;
    captureId?: string;
    interactionStepId?: string;
    payload: Record<string, unknown>;
  }): Evidence | null {
    if (input.captureId) {
      const existing = this.sql.exec(
        "SELECT id FROM evidence WHERE capture_id = ? LIMIT 1",
        input.captureId,
      ).toArray();
      if (existing.length > 0) {
        return this.getEvidence(String(existing[0].id));
      }
    }
    const id = this.nextId();
    this.sql.exec(
      `INSERT INTO evidence (id, run_id, site, page_url, ts, kind, source, dest, capture_id, interaction_step_id, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      this.runId,
      this.site,
      input.pageUrl,
      input.timestamp,
      input.kind,
      input.source,
      input.dest ?? null,
      input.captureId ?? null,
      input.interactionStepId ?? null,
      JSON.stringify(input.payload),
    );
    return this.getEvidence(id);
  }

  getEvidence(id: string): Evidence | null {
    const rows = this.sql.exec("SELECT * FROM evidence WHERE id = ?", id).toArray();
    return rows.length > 0 ? rowToEvidence(rows[0]) : null;
  }

  listEvidence(): Evidence[] {
    return this.sql
      .exec("SELECT * FROM evidence ORDER BY id ASC")
      .toArray()
      .map(rowToEvidence);
  }

  /** Evidence referenced by ID list; unknown IDs are dropped. */
  evidenceByIds(ids: string[]): Evidence[] {
    const found: Evidence[] = [];
    for (const id of ids) {
      const e = this.getEvidence(id);
      if (e) found.push(e);
    }
    return found;
  }

  /** Interaction that fired a beacon, from its step ID. */
  interactionFor(e: Evidence): InteractionKind {
    const step = e.interactionStepId;
    if (!step) return "load";
    if (step.startsWith("S-click")) return "click";
    if (step.startsWith("S-form")) return "form_submit";
    if (step.startsWith("S-consent")) return "consent_toggle";
    return "other";
  }

  /** Compact per-ID digest for the reviewer/Jev: small payloads, full event names. */
  digest(): { id: string; kind: string; pageUrl: string; interaction: string; summary: Record<string, unknown> }[] {
    return this.listEvidence().map((e) => ({
      id: e.id,
      kind: e.kind,
      pageUrl: e.pageUrl,
      interaction: e.interactionStepId ?? "load",
      summary: compactPayload(e.payload),
    }));
  }

  log(event: string, detail?: unknown): void {
    this.sql.exec(
      "INSERT INTO run_log (ts, event, detail) VALUES (?, ?, ?)",
      new Date().toISOString(),
      event,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  recentLog(limit = 200): { seq: number; ts: string; event: string; detail: string | null }[] {
    const rows = this.sql
      .exec("SELECT * FROM run_log ORDER BY seq DESC LIMIT ?", Math.min(limit, 1000))
      .toArray();
    return rows
      .map((r) => ({
        seq: Number(r.seq),
        ts: String(r.ts),
        event: String(r.event),
        detail: r.detail === null || r.detail === undefined ? null : JSON.stringify(r.detail),
      }))
      .reverse();
  }

  persistReport(markdown: string, json: string): void {
    this.sql.exec(
      "INSERT OR REPLACE INTO reports (run_id, markdown, json, created_at) VALUES (?, ?, ?, ?)",
      this.runId,
      markdown,
      json,
      new Date().toISOString(),
    );
  }

  getReport(): { markdown: string; json: string; createdAt: string } | null {
    const rows = this.sql.exec("SELECT * FROM reports WHERE run_id = ?", this.runId).toArray();
    if (rows.length === 0) return null;
    return {
      markdown: String(rows[0].markdown),
      json: String(rows[0].json),
      createdAt: String(rows[0].created_at),
    };
  }
}

function rowToEvidence(row: Record<string, unknown>): Evidence {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    site: String(row.site),
    pageUrl: String(row.page_url),
    timestamp: String(row.ts),
    kind: String(row.kind) as EvidenceKind,
    source: String(row.source) as EvidenceSource,
    dest: row.dest === null || row.dest === undefined ? undefined : (String(row.dest) as Destination),
    captureId: row.capture_id === null || row.capture_id === undefined ? undefined : String(row.capture_id),
    interactionStepId:
      row.interaction_step_id === null || row.interaction_step_id === undefined
        ? undefined
        : String(row.interaction_step_id),
    payload: safeJson(row.payload),
  };
}

function safeJson(value: unknown): Record<string, unknown> {
  try {
    const v = JSON.parse(String(value));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Keep payload digests small: truncate long values, cap array/object depth. */
export function compactPayload(payload: Record<string, unknown>, maxChars = 240): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload).slice(0, 40)) {
    if (v === null || typeof v !== "object") {
      const s = String(v ?? "");
      out[k] = s.length > maxChars ? s.slice(0, maxChars) + "…" : v;
    } else {
      try {
        const s = JSON.stringify(v);
        out[k] = s.length > maxChars ? s.slice(0, maxChars) + "…" : JSON.parse(s);
      } catch {
        out[k] = String(v).slice(0, maxChars);
      }
    }
  }
  return out;
}
