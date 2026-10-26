import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// The IPO: an until-IPO game, the readiness checklist on Finance turning green, applying, the opening-bell page, and
// the game ending with the cash raised, the market value at the close and the student's stake.

// Thresholds a company meets on day 2, every user paying a high price, and never a cold market.
const EASY_IPO = {
  "allowedGameLengths.until-ipo": 1,
  "productTypes.ecommerce.pricing.freeShare": 0,
  "productTypes.ecommerce.pricing.fairPrice": 100,
  "ipo.products.ecommerce.users": 0,
  "ipo.products.ecommerce.annualRevenue": 0,
  "ipo.products.ecommerce.payingUsers": 0,
  "ipo.minTradingDays": 0,
  "ipo.recordDays": 2,
  "ipo.minUptime": 0,
  "ipo.minSatisfaction": 0,
  "ipo.maxCostSwing": 5,
  "ipo.coldChance.min": 0,
  "ipo.coldChance.max": 0,
};

let code: string | null = null;
let preset: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  await request.post("/api/teacher/presets/default/activate");
  if (preset) await request.delete(`/api/teacher/presets/${preset}`);
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = preset = null;
});

/** As if the angel and Series A had approached the company on day 1 and been declined: every C-suite role opens. */
async function seriesAApproached(id: string) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{investors,vc,firstApproachDay,seriesA}', '1'), '{investors,firstApproachDay}', '1') where id = ${id}`;
  } finally {
    await sql.end();
  }
}

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("float a company that's ready, ring the opening bell and watch the first day end the game", async ({ browser, request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const created = await request.post("/api/teacher/presets", { data: { name: "Easy IPO", overrides: EASY_IPO } });
  expect(created.ok()).toBe(true);
  preset = (await created.json()).id as string;
  expect((await request.post(`/api/teacher/presets/${preset}/activate`)).ok()).toBe(true);
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;

  // An until-IPO game has no last day.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  const lengths = student.getByTestId("game-lengths");
  await expect(lengths.locator("label.choice", { hasText: "Until IPO" })).toContainText("Ends only when you float");
  await lengths.locator("label.choice", { hasText: "Until IPO" }).click();
  await student.getByText("E-commerce platform").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Bell Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText("1");

  // Finance: the checklist, not all green yet, so Apply isn't allowed.
  await goTo(student, "Finance");
  const panel = student.getByTestId("ipo-panel");
  await expect(panel.locator("li")).toHaveCount(6);
  await expect(panel.getByTestId("ipo-csuite")).toHaveAttribute("data-met", "false");
  await expect(panel.getByTestId("ipo-csuite")).toContainText("0 of 11 hired");
  await expect(panel.getByTestId("ipo-status")).toHaveText("Not ready");
  await expect(panel.getByTestId("ipo-uptime")).toHaveAttribute("data-met", "false");
  await expect(panel.getByTestId("ipo-apply")).toBeDisabled();

  // A day later the records are long enough, and every condition but the full C-suite turns green.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toHaveText("2");
  for (const id of ["trading", "usersAndRevenue", "uptime", "costs", "security"]) {
    await expect(panel.getByTestId(`ipo-${id}`)).toHaveAttribute("data-met", "true");
  }
  await expect(panel.getByTestId("ipo-csuite")).toHaveAttribute("data-met", "false");
  await expect(panel.getByTestId("ipo-status")).toHaveText("Not ready");
  await expect(panel.getByTestId("ipo-apply")).toBeDisabled();

  // Once Series A has approached (declined), every C-suite role is open: no later round is needed.
  await seriesAApproached(student.url().split("/").at(-2)!);
  await student.reload();
  await expect(panel.getByTestId("ipo-status")).toHaveText("Not ready");
  // Hired on the C-suite page, the first on each shortlist, the C-suite is full and it's ready.
  await goTo(student, "C-suite");
  await expect(student.getByTestId("csuite-ipo")).toContainText("Every role must be filled to float: 0 of 11 hired");
  const roles = ["headOfDevelopment", "headOfOps", "headOfSupport", "cfo", "cto", "headOfPeople", "cmo", "coo", "cio", "ciso", "legalCounsel"];
  for (const role of roles) {
    const first = student.getByTestId(`csuite-${role}`).locator("tbody tr").first();
    await first.getByTestId("hire-executive").click();
    await expect(student.getByTestId(`csuite-${role}`).getByTestId("csuite-executive")).toBeVisible();
  }
  await goTo(student, "Finance");
  await expect(panel.getByTestId("ipo-csuite")).toHaveAttribute("data-met", "true");
  await expect(panel.getByTestId("ipo-csuite")).toContainText("All 11 hired");
  await expect(panel.getByTestId("ipo-status")).toHaveText("Ready to apply");

  // Applying is approved (no cold market here), and the opening-bell page takes over. The game holds until the bell.
  await panel.getByTestId("ipo-apply").click();
  await expect(student).toHaveURL(/\/ipo$/);
  await expect(student.getByRole("heading", { name: "Your IPO is approved" })).toBeVisible();
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();

  // The float slider previews the cash raised and the student's stake after.
  const id = student.url().split("/").at(-2)!;
  const { ipo } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const at30 = ipo.offer.floats.find((f: { float: number }) => f.float === 0.3);
  await student.getByTestId("bell-float").fill("30");
  await expect(student.getByTestId("bell-float-value")).toHaveText("30%");
  await expect(student.getByTestId("bell-preview-cash")).toHaveText(`£${at30.cashRaised.toLocaleString("en-GB")}`);
  // The C-suite took a little equity, so the student starts a little under 100%.
  const pct = (n: number) => `${(Math.round(n * 1000) / 10).toLocaleString("en-GB")}%`;
  await expect(student.getByTestId("bell-preview-stake")).toHaveText(`${pct(ipo.offer.studentShare)} → ${pct(at30.studentShareAfter)}`);

  // Ringing the bell plays the first day, then shows the result.
  await student.getByTestId("bell-ring").click();
  await expect(student.getByTestId("bell-trading")).toBeVisible();
  const result = student.getByTestId("bell-result");
  await expect(result).toBeVisible({ timeout: 15_000 });
  const { ipo: floated } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const r = floated.result;
  await expect(result.getByTestId("bell-cash-raised")).toHaveText(`£${r.cashRaised.toLocaleString("en-GB")}`);
  await expect(result.getByTestId("bell-market-value")).toHaveText(`£${r.marketValue.toLocaleString("en-GB")}`);
  await expect(result.getByTestId("bell-stake")).toHaveText(`£${r.studentValue.toLocaleString("en-GB")}`);
  expect(r.marketValue).toBe(Math.round(r.closePrice * r.sharesAfter));

  // The game is over: Home says so, with the IPO in the summary.
  await student.getByTestId("bell-summary-link").click();
  await expect(student.getByTestId("floated-screen")).toContainText("Bell Ltd floated on day 2");
  await expect(student.getByTestId("summary")).toContainText("Floated on day 2");
  await expect(student.getByTestId("summary-market-value")).toHaveText(`£${r.marketValue.toLocaleString("en-GB")}`);
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
});
