import type { ConfigOverrides, SpendCategory } from "@xaas/sim";
import type {
  ActionBody,
  ApiError,
  CodeView,
  CompanyView,
  ConfigView,
  ContinueResult,
  MetaView,
  MigrationQuoteView,
  NewCompanyBody,
  PricePreviewView,
  SummaryView,
  TeacherCodeView,
  TeacherGamesView,
  TeacherSummaryView,
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

  // What a new price would do, for the price modal's live preview. Changes nothing.
  pricePreview: (code: string, id: string, price: number) =>
    request<PricePreviewView>(
      "GET",
      `/api/codes/${enc(code)}/companies/${enc(id)}/price-preview?price=${enc(String(price))}`,
    ),

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
  archiveCode: (code: string) => request<{ ok: true }>("POST", `/api/teacher/codes/${enc(code)}/archive`),
  unarchiveCode: (code: string) => request<{ ok: true }>("POST", `/api/teacher/codes/${enc(code)}/unarchive`),
  deleteCode: (code: string) => request<{ ok: true }>("DELETE", `/api/teacher/codes/${enc(code)}`),
  teacherSummary: (id: string) => request<TeacherSummaryView>("GET", `/api/teacher/companies/${enc(id)}/summary`),
  teacherConfig: () => request<ConfigView>("GET", "/api/teacher/config"),
  saveConfig: (overrides: ConfigOverrides) => request<ConfigView>("PUT", "/api/teacher/config", { overrides }),
  resetConfig: () => request<ConfigView>("POST", "/api/teacher/config/reset"),
};

const money = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
export const formatCash = (n: number) => money.format(n);
// For prices under a pound, such as a per-user fee: shows pence only when there are some.
const price = new Intl.NumberFormat("en-GB", { style: "currency", currency: "GBP", minimumFractionDigits: 2 });
export const formatPrice = (n: number) => (Number.isInteger(n) ? money.format(n) : price.format(n));

const count = new Intl.NumberFormat("en-GB");
export const formatCount = (n: number) => count.format(n);
// Rounds down, so a single outage never shows as 100%.
export const formatUptime = (pct: number) => (pct >= 100 ? "100%" : `${(Math.floor(pct * 10) / 10).toFixed(1)}%`);

export const CATEGORY_LABELS: Record<SpendCategory, string> = {
  staff: "Staff",
  infrastructure: "Infrastructure",
  addons: "Add-ons",
};
