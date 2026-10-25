import type { SpendCategory } from "@xaas/sim";
import type {
  ActionBody,
  ApiError,
  CodeView,
  CompanyView,
  CounterOddsView,
  PayOfferView,
  EndGamesResult,
  ContinueResult,
  LogDeleteResult,
  LogStatsView,
  MetaView,
  PlayEventKind,
  MigrationQuoteView,
  NewCompanyBody,
  PresetCreateBody,
  PresetsView,
  PresetUpdateBody,
  PresetView,
  PricePreviewView,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherSummaryView,
  TimelineView,
} from "@xaas/server/api-types";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  /** The whole error body, for errors that carry more, such as the config page's per-field errors. */
  readonly body: Partial<ApiError>;

  constructor(status: number, body: Partial<ApiError>) {
    super(body.message ?? "Something went wrong.");
    this.status = status;
    this.code = body.error ?? "unknown";
    this.body = body;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new RequestError(res.status, data);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  meta: () => request<MetaView>("GET", "/api/meta"),
  code: (code: string) => request<CodeView>("GET", `/api/codes/${enc(code)}`),
  createCompany: (code: string, body: NewCompanyBody) =>
    request<CompanyView>("POST", `/api/codes/${enc(code)}/companies`, body),
  company: (code: string, id: string) => request<CompanyView>("GET", `/api/codes/${enc(code)}/companies/${enc(id)}`),
  // The numbers a game shows, from the config it started with.
  companyMeta: (code: string, id: string) =>
    request<MetaView>("GET", `/api/codes/${enc(code)}/companies/${enc(id)}/meta`),
  retire: (code: string, id: string) =>
    request<CompanyView>("POST", `/api/codes/${enc(code)}/companies/${enc(id)}/retire`),
  summary: (code: string, id: string) =>
    request<SummaryView>("GET", `/api/codes/${enc(code)}/companies/${enc(id)}/summary`),
  continueDay: (code: string, id: string) =>
    request<ContinueResult>("POST", `/api/codes/${enc(code)}/companies/${enc(id)}/continue`),
  act: (code: string, id: string, action: ActionBody) =>
    request<CompanyView>("POST", `/api/codes/${enc(code)}/companies/${enc(id)}/actions`, action),
  migrationQuote: (code: string, id: string, target: string) =>
    request<MigrationQuoteView>(
      "GET",
      `/api/codes/${enc(code)}/companies/${enc(id)}/migration-quote?target=${enc(target)}`,
    ),

  // What a new price would do, for the price modal's live preview. Changes nothing. On the payments app, with the
  // transaction fee (a share, 0.02 = 2%) to preview with it.
  pricePreview: (code: string, id: string, price: number, rate?: number) =>
    request<PricePreviewView>(
      "GET",
      `/api/codes/${enc(code)}/companies/${enc(id)}/price-preview?price=${enc(String(price))}` +
        (rate === undefined ? "" : `&rate=${enc(String(rate))}`),
    ),

  // What a counter to a funder's offer would do, for the negotiation modal's live odds. Changes nothing.
  counterOdds: (code: string, id: string, funder: string, terms: Record<string, number>) =>
    request<CounterOddsView>(
      "GET",
      `/api/codes/${enc(code)}/companies/${enc(id)}/counter-odds?${new URLSearchParams({ funder, ...Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, String(v)])) })}`,
    ),

  // The same for an investor's open approach (the angel's).
  investorOdds: (code: string, id: string, terms: Record<string, number>) =>
    request<CounterOddsView>(
      "GET",
      `/api/codes/${enc(code)}/companies/${enc(id)}/investor-odds?${new URLSearchParams(Object.fromEntries(Object.entries(terms).map(([k, v]) => [k, String(v)])))}`,
    ),

  // What offering staff a rise in the open pay review would do, for the pay review modal's live cost and odds.
  payOffer: (code: string, id: string, rise: number) =>
    request<PayOfferView>("GET", `/api/codes/${enc(code)}/companies/${enc(id)}/pay-offer?${new URLSearchParams({ rise: String(rise) })}`),

  teacherLogin: (password: string) => request<{ ok: true }>("POST", "/api/teacher/login", { password }),
  teacherLogout: () => request<{ ok: true }>("POST", "/api/teacher/logout"),
  teacherMe: () => request<{ ok: true }>("GET", "/api/teacher/me"),
  teacherCodes: () => request<TeacherCodeView[]>("GET", "/api/teacher/codes"),
  createCode: () => request<TeacherCodeView>("POST", "/api/teacher/codes"),
  // Without hours, the server's default window.
  teacherGames: (hours?: number) =>
    request<TeacherGamesView>("GET", `/api/teacher/games${hours === undefined ? "" : `?hours=${hours}`}`),
  archivedGames: () => request<TeacherGamesView>("GET", "/api/teacher/games?archived=true"),
  archiveGame: (id: string) => request<{ ok: true }>("POST", `/api/teacher/companies/${enc(id)}/archive`),
  unarchiveGame: (id: string) => request<{ ok: true }>("POST", `/api/teacher/companies/${enc(id)}/unarchive`),
  deleteGame: (id: string) => request<{ ok: true }>("DELETE", `/api/teacher/companies/${enc(id)}`),
  endGame: (id: string) => request<EndGamesResult>("POST", `/api/teacher/companies/${enc(id)}/end`),
  endCodeGames: (code: string) => request<EndGamesResult>("POST", `/api/teacher/codes/${enc(code)}/end`),
  archiveCode: (code: string) => request<{ ok: true }>("POST", `/api/teacher/codes/${enc(code)}/archive`),
  unarchiveCode: (code: string) => request<{ ok: true }>("POST", `/api/teacher/codes/${enc(code)}/unarchive`),
  deleteCode: (code: string) => request<{ ok: true }>("DELETE", `/api/teacher/codes/${enc(code)}`),
  teacherSummary: (id: string) => request<TeacherSummaryView>("GET", `/api/teacher/companies/${enc(id)}/summary`),
  presets: () => request<PresetsView>("GET", "/api/teacher/presets"),
  preset: (id: string) => request<PresetView>("GET", `/api/teacher/presets/${enc(id)}`),
  createPreset: (body: PresetCreateBody) => request<PresetView>("POST", "/api/teacher/presets", body),
  updatePreset: (id: string, body: PresetUpdateBody) =>
    request<PresetView>("PATCH", `/api/teacher/presets/${enc(id)}`, body),
  deletePreset: (id: string) => request<PresetsView>("DELETE", `/api/teacher/presets/${enc(id)}`),
  activatePreset: (id: string) => request<PresetsView>("POST", `/api/teacher/presets/${enc(id)}/activate`),

  // The playtest log: a company's timeline, how much there is, and deleting it by game, by code or all.
  timeline: (id: string, kind?: PlayEventKind) =>
    request<TimelineView>("GET", `/api/teacher/companies/${enc(id)}/timeline${kind ? `?kind=${kind}` : ""}`),
  logStats: () => request<LogStatsView>("GET", "/api/teacher/logs"),
  deleteGameLogs: (id: string) => request<LogDeleteResult>("DELETE", `/api/teacher/companies/${enc(id)}/logs`),
  deleteCodeLogs: (code: string) => request<LogDeleteResult>("DELETE", `/api/teacher/codes/${enc(code)}/logs`),
  deleteAllLogs: () => request<LogDeleteResult>("DELETE", "/api/teacher/logs"),
};

/** The export's address, for a download link: the teacher's cookie goes with it. Empty filters are left out. */
export function logExportUrl(format: "csv" | "json", filters: Record<string, string | undefined> = {}) {
  const query = new URLSearchParams({ format });
  for (const [key, value] of Object.entries(filters)) if (value) query.set(key, value);
  return `/api/teacher/logs/export?${query}`;
}

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const formatCash = (n: number) => money.format(n);
// For prices under a pound, such as a per-user fee: shows pence only when there are some.
const price = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });
export const formatPrice = (n: number) => (Number.isInteger(n) ? money.format(n) : price.format(n));
/** A transaction fee as a percentage, to at most two places: 0.025 is "2.5%". */
export const formatRate = (rate: number) => `${Math.round(rate * 10_000) / 100}%`;

const count = new Intl.NumberFormat("en-GB");
export const formatCount = (n: number) => count.format(n);
// Rounds down, so a single outage never shows as 100%.
export const formatUptime = (pct: number) => (pct >= 100 ? "100%" : `${(Math.floor(pct * 10) / 10).toFixed(1)}%`);

export const CATEGORY_LABELS: Record<SpendCategory, string> = {
  staff: "Staff",
  infrastructure: "Infrastructure",
  cabling: "Cabling",
  power: "Power and cooling",
  addons: "Add-ons",
  campaigns: "Campaigns",
  debt: "Debt",
};
