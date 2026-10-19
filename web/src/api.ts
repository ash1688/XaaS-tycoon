import type {
  ActionBody,
  ApiError,
  CodeView,
  CompanyView,
  ContinueResult,
  MetaView,
  NewCompanyBody,
  TeacherCodeView,
} from "@xaas/server/api-types";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, body: Partial<ApiError>) {
    super(body.message ?? "Something went wrong.");
    this.status = status;
    this.code = body.error ?? "unknown";
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
  continueDay: (code: string, id: string) =>
    request<ContinueResult>("POST", `/api/codes/${enc(code)}/companies/${enc(id)}/continue`),
  act: (code: string, id: string, action: ActionBody) =>
    request<CompanyView>("POST", `/api/codes/${enc(code)}/companies/${enc(id)}/actions`, action),

  teacherLogin: (password: string) => request<{ ok: true }>("POST", "/api/teacher/login", { password }),
  teacherLogout: () => request<{ ok: true }>("POST", "/api/teacher/logout"),
  teacherMe: () => request<{ ok: true }>("GET", "/api/teacher/me"),
  teacherCodes: () => request<TeacherCodeView[]>("GET", "/api/teacher/codes"),
  createCode: () => request<TeacherCodeView>("POST", "/api/teacher/codes"),
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
