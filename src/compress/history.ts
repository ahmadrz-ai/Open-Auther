/**
 * Caveman history.
 *
 * Compression used to be visible only as an aggregate token count, which
 * answers "how much" but never "what did it do to my prompt" or "why did it
 * decline". Every attempt is recorded here with both sides of the exchange.
 *
 * The stored text is truncated: this is for eyeballing what happened, not an
 * archive of every prompt that has passed through the gateway.
 */

import { type Database, now } from "../db.js";
import { createLogger } from "../logging.js";

const log = createLogger({ mod: "caveman-history" });

/** Per-side cap on stored text. Enough to see the shape, not the whole novel. */
const MAX_TEXT = 8000;
const MAX_ROWS = 300;

export type CavemanOutcome = "compressed" | "skipped" | "failed" | "no_gain";

export interface CavemanHistoryEntry {
  id?: number;
  ts: number;
  outcome: CavemanOutcome;
  model: string | null;
  beforeTokens: number;
  afterTokens: number;
  latencyMs: number | null;
  inputText: string | null;
  outputText: string | null;
  error: string | null;
}

const clip = (text: string | null | undefined): string | null => {
  if (!text) return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… (${text.length - MAX_TEXT} more characters)` : text;
};

export class CavemanHistory {
  constructor(private readonly db: Database) {}

  /** Never throws: history is a diagnostic, and must not fail a request. */
  record(entry: Omit<CavemanHistoryEntry, "ts"> & { ts?: number }): void {
    try {
      this.db
        .prepare(
          `INSERT INTO caveman_history
             (ts, outcome, model, before_tokens, after_tokens, latency_ms,
              input_text, output_text, error)
           VALUES (?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          entry.ts ?? now(),
          entry.outcome,
          entry.model,
          entry.beforeTokens,
          entry.afterTokens,
          entry.latencyMs,
          clip(entry.inputText),
          clip(entry.outputText),
          entry.error,
        );

      this.db.exec(
        `DELETE FROM caveman_history
          WHERE id <= (SELECT MAX(id) - ${MAX_ROWS} FROM caveman_history)`,
      );
    } catch (err) {
      log.debug("caveman_history_write_failed", { err });
    }
  }

  list(limit = 50, outcome?: string): CavemanHistoryEntry[] {
    const where = outcome ? "WHERE outcome = ?" : "";
    const params: unknown[] = outcome ? [outcome, limit] : [limit];

    const rows = this.db
      .prepare(`SELECT * FROM caveman_history ${where} ORDER BY id DESC LIMIT ?`)
      .all(...(params as never[])) as unknown as Array<Record<string, unknown>>;

    return rows.map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      outcome: r.outcome as CavemanOutcome,
      model: r.model as string | null,
      beforeTokens: r.before_tokens as number,
      afterTokens: r.after_tokens as number,
      latencyMs: r.latency_ms as number | null,
      inputText: r.input_text as string | null,
      outputText: r.output_text as string | null,
      error: r.error as string | null,
    }));
  }

  stats(): {
    total: number;
    compressed: number;
    failed: number;
    skipped: number;
    tokensSaved: number;
    avgLatencyMs: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome = 'compressed' THEN 1 ELSE 0 END) AS compressed,
                SUM(CASE WHEN outcome = 'failed'     THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN outcome IN ('skipped','no_gain') THEN 1 ELSE 0 END) AS skipped,
                COALESCE(SUM(CASE WHEN outcome = 'compressed'
                                  THEN before_tokens - after_tokens ELSE 0 END), 0) AS saved,
                COALESCE(AVG(latency_ms), 0) AS avg_latency
           FROM caveman_history`,
      )
      .get() as Record<string, number | null>;

    return {
      total: Number(row.total ?? 0),
      compressed: Number(row.compressed ?? 0),
      failed: Number(row.failed ?? 0),
      skipped: Number(row.skipped ?? 0),
      tokensSaved: Number(row.saved ?? 0),
      avgLatencyMs: Math.round(Number(row.avg_latency ?? 0)),
    };
  }

  clear(): void {
    this.db.exec("DELETE FROM caveman_history");
  }
}
