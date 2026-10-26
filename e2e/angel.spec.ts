import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// The angel investor: the approach and its notification, the offer with its target on Finance, negotiating and
// accepting it (the valuation it sets, friends and family and the grant closing), and declining one for another. The
// first approach also opens researchers and the Research page, whatever the student makes of the angel.

// A hidden target any launched company hits on its first day of income, so an angel approaches within days, and a
// target short enough for an angel to come in a 30-day game.
const EARLY_ANGEL = {
  "investors.angel.targetDays": 10,
  "investors.approachDays": 1,
  "investors.retryDays": 2,
  "investors.angel.target.dailyRevenue": 100,
  "investors.angel.target.days": 1,
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

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

/** A SaaS social network on the early-angel preset, played on until an angel approaches. */
async function startAndWaitForAngel(
  browser: import("@playwright/test").Browser,
  request: import("@playwright/test").APIRequestContext,
  name: string,
  overrides: Record<string, number> = {},
) {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const created = await request.post("/api/teacher/presets", { data: { name: "Early angel", overrides: { ...EARLY_ANGEL, ...overrides } } });
  expect(created.ok()).toBe(true);
  preset = (await created.json()).id as string;
  expect((await request.post(`/api/teacher/presets/${preset}/activate`)).ok()).toBe(true);
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill(name);
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText(/^1 of/);
  await goTo(student, "Finance");
  await expect(student.getByTestId("angel")).toContainText("Investors come to you");
  await expect(student.getByTestId("investor-note")).toBeHidden();
  // Research opens only once an angel approaches.
  await expect(student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Research", exact: true })).toBeHidden();

  const note = student.getByTestId("investor-note");
  for (let i = 0; i < 10 && !(await note.isVisible()); i++) {
    const day = Number(await student.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
  }
  await expect(note).toBeVisible();
  return student;
}

test("an angel approaches with a notification; their offer shows its target, and accepting it sets the valuation and closes friends and family", async ({
  browser,
  request,
}) => {
  const student = await startAndWaitForAngel(browser, request, "Angel Ltd");
  const id = student.url().replace(/\/finance$/, "").split("/").at(-1)!;

  // The notification: time stopped for it, and Finance is flagged on every page.
  await expect(student.getByTestId("pause-reasons")).toContainText("an angel investor, wants to invest");
  await expect(student.getByTestId("finance-badge")).toBeVisible();
  await goTo(student, "Home");
  await expect(student.getByTestId("investor-note")).toContainText("likes what you're doing and wants to invest");
  await student.getByTestId("investor-note").getByRole("link", { name: "See their offer on Finance" }).click();

  // The offer, with its target and what missing it costs, before it's accepted.
  const panel = student.getByTestId("investor-panel");
  await expect(panel.getByTestId("angel-offer")).toContainText("wants to invest");
  await expect(panel.getByTestId("angel-days-left")).toContainText(/Answer by day \d+ \(3 days left\): unanswered, it lapses/);
  await panel.getByTestId("angel-review").click();
  const modal = student.getByRole("dialog", { name: "Angel investor's offer" });
  await expect(modal.getByTestId("angel-condition")).toContainText(/^By day \d+ \(10 days after you accept\), both at once: grow income to £[\d,]+ a day, averaged over 1 day, and gain [\d,]+ users net from the day you accept/);
  await expect(modal.getByTestId("angel-if-missed")).toContainText("takes extra equity");
  await expect(modal.getByTestId("angel-effects")).toContainText("Friends and family and grants close for good");
  await expect(modal.getByTestId("angel-valuation")).toContainText("before their cash");

  // Negotiate once: the odds, then a roll and a new offer.
  const talks = modal.getByTestId("negotiation");
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 1 of 3");
  const share = Number(await talks.getByTestId("counter-share").inputValue());
  await talks.getByTestId("counter-share").fill(String(Math.round(share * 9) / 10));
  await expect(talks.getByTestId("counter-odds")).toContainText("That asks 10% better terms");
  await talks.getByTestId("funding-counter").click();
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 2 of 3");
  await expect(talks.getByTestId("negotiation-round")).toHaveCount(1);

  // Accepting takes the offer that stands.
  const before = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const offer = before.investors.offer;
  await modal.getByTestId("angel-accept").click();
  await expect(modal).toBeHidden();
  await expect(panel.getByTestId("angel-deal")).toContainText(`${offer.investor} put in`);
  await expect(panel.getByTestId("angel-target")).toContainText("Their target, both at once by day");
  await expect(panel.getByTestId("angel-target-users")).toContainText(/Users since you accepted, free and paying: [\d,]+ gained, [\d,]+ lost, so -?[\d,]+ net of [\d,]+/);
  await expect(student.getByTestId("investor-note")).toBeHidden();
  await expect(student.getByTestId("finance-badge")).toBeHidden();
  const after = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(after.cash).toBe(before.cash + offer.amount);
  expect(after.capTable.rows[1]).toMatchObject({ id: "angel", shares: offer.newShares });

  // The valuation is theirs now, and friends and family and the grant are gone.
  await expect(student.getByTestId("driver-investor")).toContainText("your angel, valued the business at");
  await expect(student.getByTestId("funding-closed")).toContainText("closed on day");
  await expect(student.getByTestId("funder-friendsAndFamily")).toContainText("Closed");
  await expect(student.getByTestId("funder-grant")).toContainText("Closed");
  await expect(student.getByTestId("ff-review")).toBeHidden();
  await expect(student.getByTestId("grant-review")).toBeHidden();
});

test("auto-negotiating the angel plays on to their final offer with a transcript, and leaves Accept and Decline to the student", async ({
  browser,
  request,
}) => {
  const student = await startAndWaitForAngel(browser, request, "Auto Angel Ltd");
  const id = student.url().replace(/\/finance$/, "").split("/").at(-1)!;
  await student.getByTestId("investor-panel").getByTestId("angel-review").click();
  const modal = student.getByRole("dialog", { name: "Angel investor's offer" });
  const talks = modal.getByTestId("negotiation");
  const share = Number(await talks.getByTestId("counter-share").inputValue());
  await talks.getByTestId("counter-share").fill(String(Math.round(share * 9) / 10));
  await expect(talks.getByTestId("counter-odds")).toContainText("That asks 10% better terms");
  const before = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();

  await talks.getByTestId("auto-negotiate").click();
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Final offer");
  await expect(talks.getByTestId("auto-round")).toHaveCount(2);
  await expect(talks.getByTestId("auto-round").nth(0)).toContainText(
    /Offer 2: they (moved most of the way|met you halfway|barely moved|dug in: their offer got worse) \(£[\d,]+ for [\d.]+%\)\./,
  );
  await expect(talks.getByTestId("auto-round").nth(1)).toContainText(/Offer 3: they /);
  await expect(talks.getByTestId("negotiation-round")).toHaveCount(2);
  await expect(talks.getByTestId("auto-negotiate")).toBeHidden();
  // It never accepts: the final offer stands, and the student answers it.
  const after = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(after.cash).toBe(before.cash);
  expect(after.investors.angel).toBeNull();
  await expect(modal.getByTestId("angel-accept")).toBeEnabled();
  await expect(modal.getByTestId("angel-decline")).toBeEnabled();
  await modal.getByTestId("angel-accept").click();
  await expect(modal).toBeHidden();
  await expect(student.getByTestId("investor-panel").getByTestId("angel-deal")).toContainText(`${after.investors.offer.investor} put in`);
});

test("declining an angel brings another a few days later", async ({ browser, request }) => {
  const student = await startAndWaitForAngel(browser, request, "Picky Ltd");
  const panel = student.getByTestId("investor-panel");
  const first = (await panel.getByTestId("angel-offer").locator("strong").first().textContent())!;
  await panel.getByTestId("angel-review").click();
  await student.getByRole("dialog", { name: "Angel investor's offer" }).getByTestId("angel-decline").click();
  await expect(panel.getByTestId("angel-coming")).toContainText(`You declined ${first}`);
  await expect(student.getByTestId("investor-note")).toBeHidden();
  // Friends and family are still there to ask.
  await expect(student.getByTestId("ff-review")).toBeVisible();

  const note = student.getByTestId("investor-note");
  for (let i = 0; i < 5 && !(await note.isVisible()); i++) {
    const day = Number(await student.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
  }
  await expect(note).toBeVisible();
  await expect(panel.getByTestId("angel-offer")).not.toContainText(first);
});

test("the first angel's approach opens researchers and the Research page, which stay open when the angel is declined", async ({
  browser,
  request,
}) => {
  // Mids start at once, so a researcher hired today earns RP on the next day played.
  const student = await startAndWaitForAngel(browser, request, "Lab Ltd", { "staffGrades.mid.leadDays": 0 });
  const panel = student.getByTestId("investor-panel");
  await panel.getByTestId("angel-review").click();
  await student.getByRole("dialog", { name: "Angel investor's offer" }).getByTestId("angel-decline").click();
  await expect(panel.getByTestId("angel-coming")).toBeVisible();

  await goTo(student, "Research");
  await expect(student.getByTestId("research-points")).toHaveText("0 RP");
  await expect(student.getByTestId("research-per-day")).toHaveText("0");

  // People has a researchers row, permanent only.
  await goTo(student, "People");
  const row = student.locator('[data-pool="researchers"]');
  await expect(row).toBeVisible();
  await expect(row.getByTestId("researchers-permanent-only")).toContainText("Permanent hires only");
  await expect(row.getByTestId("researchers-agency-pick")).toHaveCount(0);
  await row.getByRole("button", { name: "Hire one mid researcher" }).click();
  await expect(row.getByTestId("researchers-count")).toHaveText("1");

  const day = Number(await student.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
  await goTo(student, "Research");
  await expect(student.getByTestId("research-per-day")).toHaveText("4");
  await expect(student.getByTestId("research-points")).toHaveText("4 RP");
});
