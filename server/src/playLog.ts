// The playtest log: an always-on, anonymised record of what students do, for the teacher to review afterwards. Game
// events come from the server as each request is handled; UI events come from the student's browser in batches.
//
// Logging must never break or slow down play, so a request only queues its rows. They're written together a moment
// later, after the response, and a failed write is reported and dropped rather than failing anything.
import type { Db } from "./db/client.ts";
import { playEvents } from "./db/schema.ts";
import type { CompanyView, PlayEventKind, PlaySnapshot } from "./api-types.ts";

export type PlayEventRow = typeof playEvents.$inferInsert;

/** Rows per insert: well under Postgres's limit of 65,535 parameters, at 10 a row. */
const ROWS_PER_INSERT = 1000;

export class PlayLog {
  private queued: PlayEventRow[] = [];
  private scheduled = false;
  // Writes run one after another, so rows go in, and get their ids, in the order they were recorded.
  private written: Promise<void> = Promise.resolve();

  constructor(
    private readonly db: Db,
    private readonly onError: (err: unknown) => void,
  ) {}

  /** Queues rows to be written once the current request has been answered. Never throws. */
  record(...rows: PlayEventRow[]) {
    this.queued.push(...rows);
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      const batch = this.queued.splice(0);
      this.written = this.written.then(() => this.write(batch));
    });
  }

  /** Resolves once everything queued so far has been written (or has failed). For tests, reads and shutdown. */
  async flush() {
    while (this.scheduled) await new Promise((resolve) => setImmediate(resolve));
    await this.written;
  }

  private async write(rows: PlayEventRow[]) {
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      try {
        await this.db.insert(playEvents).values(rows.slice(i, i + ROWS_PER_INSERT));
      } catch (err) {
        this.onError(err);
      }
    }
  }
}

/** The key numbers of a game event, from the view the request already built for the student. */
export function snapshotOf(company: CompanyView): PlaySnapshot {
  const { units, loan } = company;
  let tier: PlaySnapshot["tier"] = null;
  let tierUse: number | null = null;
  let noCapacity = false;
  if (units) {
    // The tier that runs out first, as the game's capacity bars show it. With demand and no capacity at all there's no
    // percentage to give (the bars show 999%), so it's null and flagged instead.
    tier = units.binding;
    const { demand, capacity } = units[tier];
    noCapacity = capacity <= 0 && demand > 0;
    tierUse = capacity > 0 ? Math.round((100 * demand) / capacity) : noCapacity ? null : 0;
  } else if (company.capacity) {
    tierUse = Math.round((100 * company.load) / company.capacity);
  }
  return {
    day: company.day,
    cash: Math.round(company.cash),
    paidUsers: company.paidUsers,
    freeUsers: company.freeUsers,
    dailyIncome: Math.round(company.dailyIncome),
    satisfaction: company.satisfaction,
    uptime: Math.round(company.uptime * 10) / 10,
    tier,
    tierUse,
    noCapacity,
    model: company.model,
    developers: company.developers,
    ops: company.ops,
    support: company.support,
    loan: !loan ? "none" : loan.remaining > 0 ? "repaying" : "repaid",
    loanRemaining: loan ? Math.round(loan.remaining) : null,
  };
}

export const pseudonym = (player: number) => `Player ${player}`;
export const testerId = (tester: number) => `Tester ${tester}`;

/** The 999% that snapshots logged before noCapacity, for demand with no capacity. */
const NO_CAPACITY_PLACEHOLDER = 999;

/** A stored snapshot as it's shown: ones logged before noCapacity have it worked out from their 999. */
export function cleanSnapshot<T extends Partial<PlaySnapshot> | null>(snapshot: T): T {
  if (!snapshot || "noCapacity" in snapshot) return snapshot;
  const noCapacity = snapshot.tierUse === NO_CAPACITY_PLACEHOLDER;
  return { ...snapshot, tierUse: noCapacity ? null : snapshot.tierUse, noCapacity };
}

/** One exported event: flat, with the key numbers as columns and the parameters as JSON. */
export interface ExportRow {
  at: string;
  tester: string;
  player: string;
  preset: string;
  productType: string;
  kind: PlayEventKind;
  type: string;
  ok: boolean | null;
  error: string | null;
  day: number;
  cash: number | null;
  paidUsers: number | null;
  freeUsers: number | null;
  dailyIncome: number | null;
  satisfaction: number | null;
  uptime: number | null;
  tier: string | null;
  tierUse: number | null;
  noCapacity: boolean | null;
  model: string | null;
  developers: number | null;
  ops: number | null;
  support: number | null;
  loan: string | null;
  loanRemaining: number | null;
  params: Record<string, unknown>;
}

const SNAPSHOT_COLUMNS = [
  "cash",
  "paidUsers",
  "freeUsers",
  "dailyIncome",
  "satisfaction",
  "uptime",
  "tier",
  "tierUse",
  "noCapacity",
  "model",
  "developers",
  "ops",
  "support",
  "loan",
  "loanRemaining",
] as const satisfies readonly (keyof PlaySnapshot & keyof ExportRow)[];

export const EXPORT_COLUMNS = [
  "at",
  "tester",
  "player",
  "preset",
  "productType",
  "kind",
  "type",
  "ok",
  "error",
  "day",
  ...SNAPSHOT_COLUMNS,
  "params",
] as const satisfies readonly (keyof ExportRow)[];

export function exportRow(
  e: { at: Date; kind: string; type: string; ok: boolean | null; error: string | null; day: number },
  params: Record<string, unknown>,
  snapshot: Partial<PlaySnapshot> | null,
  company: { tester: number; player: number; preset: string; productType: string },
): ExportRow {
  const clean = cleanSnapshot(snapshot);
  const numbers = Object.fromEntries(SNAPSHOT_COLUMNS.map((c) => [c, clean?.[c] ?? null]));
  return {
    at: e.at.toISOString(),
    tester: testerId(company.tester),
    player: pseudonym(company.player),
    preset: company.preset,
    productType: company.productType,
    kind: e.kind as PlayEventKind,
    type: e.type,
    ok: e.ok,
    error: e.error,
    day: e.day,
    ...(numbers as Pick<ExportRow, (typeof SNAPSHOT_COLUMNS)[number]>),
    params,
  };
}

/** A CSV cell: quoted when it has a comma, quote or line break. Cells that a spreadsheet would run as a formula are prefixed with a quote. */
function csvCell(value: unknown) {
  if (value === null || value === undefined) return "";
  let text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === "string") text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: ExportRow[]) {
  const lines = [EXPORT_COLUMNS.join(",")];
  for (const row of rows) lines.push(EXPORT_COLUMNS.map((c) => csvCell(row[c])).join(","));
  return `${lines.join("\r\n")}\r\n`;
}
