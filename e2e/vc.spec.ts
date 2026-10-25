import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Venture capital: Series A's three VCs approaching with a notification, the rounds on Finance and the IPO checklist,
// picking one (which closes the other two), negotiating and accepting (the valuation theirs, a VC on the cap table),
// and the lead VC coming back for Series B.

// An angel within days of the launch, then each round two days after the one before, at targets any launched company
// hits, so Series A and B come in a 30-day game.
const EARLY_VC = {
  "investors.angel.targetDays": 10,
  "investors.approachDays": 1,
  "investors.retryDays": 2,
  "investors.angel.target.dailyRevenue": 100,
  "investors.angel.target.days": 1,
  "investors.vc.gapDays": 2,
  "investors.vc.targetDays": 1,
  "investors.vc.rounds.seriesA.target.payingUsers": 0.01,
  "investors.vc.rounds.seriesB.target.dailyRevenue": 0,
  "investors.vc.rounds.seriesB.target.payingUsers": 0.01,
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

/** Plays on a day at a time, leaving any angel's offer to lapse, until `testid` shows. */
async function continueUntil(page: Page, testid: string, most = 25) {
  const note = page.getByTestId(testid);
  for (let i = 0; i < most && !(await note.isVisible()); i++) {
    const day = Number(await page.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
  }
  await expect(note).toBeVisible();
}

test("Series A's three VCs approach; picking one closes the others, accepting sets the valuation, and the lead VC returns for Series B", async ({
  browser,
  request,
}) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const created = await request.post("/api/teacher/presets", { data: { name: "Early VC", overrides: EARLY_VC } });
  expect(created.ok()).toBe(true);
  preset = (await created.json()).id as string;
  expect((await request.post(`/api/teacher/presets/${preset}/activate`)).ok()).toBe(true);
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Venture Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText(/^1 of/);
  await goTo(student, "Finance");
  const panel = student.getByTestId("investor-panel");
  await expect(panel.getByTestId("vc")).toContainText("Every round must approach before you can float");
  await expect(panel.getByTestId("vc-round-seriesA")).toContainText("Series A not yet");

  // The approach: time stopped for it, and a notification on every page.
  await continueUntil(student, "vc-note");
  await expect(student.getByTestId("pause-reasons")).toContainText("Series A: three VCs want to invest");
  await expect(student.getByTestId("finance-badge")).toBeVisible();
  await expect(student.getByTestId("vc-note")).toContainText("Three venture capitalists want to invest");
  await expect(panel.getByTestId("vc-round-seriesA")).toContainText(/Series A approached day \d+ ✓/);
  await expect(student.getByTestId("ipo-seriesA")).toHaveAttribute("data-met", "true");
  await expect(student.getByTestId("ipo-seriesB")).toHaveAttribute("data-met", "false");

  // Three offers, each with its lean; picking one closes the other two and opens its offer.
  const offers = panel.locator("[data-vc-offer]");
  await expect(offers).toHaveCount(3);
  await expect(offers.getByText(/^(Most cash|Fewest conditions|Least ownership)$/)).toHaveCount(3);
  const name = (await offers.nth(1).locator("strong").first().textContent())!;
  await offers.nth(1).getByTestId("vc-pick").click();
  const modal = student.getByRole("dialog", { name: "Series A offer" });
  await expect(modal).toBeVisible();
  await expect(modal.getByTestId("vc-effects")).toContainText("They become your lead VC");
  await expect(offers.getByText("Closed")).toHaveCount(2);

  // Negotiate once, then accept the offer that stands.
  const talks = modal.getByTestId("negotiation");
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 1 of 3");
  const share = Number(await talks.getByTestId("counter-share").inputValue());
  await talks.getByTestId("counter-share").fill(String(Math.round(share * 9) / 10));
  await talks.getByTestId("funding-counter").click();
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 2 of 3");
  await modal.getByTestId("vc-accept").click();
  await expect(modal).toBeHidden();
  await expect(student.getByTestId("vc-note")).toBeHidden();
  await expect(panel.getByTestId("vc-round-seriesA")).toContainText(`${name} put in`);
  await expect(panel.getByTestId("vc-lead")).toContainText(`${name} is your lead VC`);
  await expect(student.getByTestId("driver-investor")).toContainText(`${name}, your Series A VC, valued the business at`);
  await expect(student.getByTestId("cap-vc")).toContainText(`${name} (VC)`);

  // Series B: the lead VC is back alongside two new VCs.
  await continueUntil(student, "vc-note");
  await expect(student.getByTestId("vc-note")).toContainText("Series B");
  await expect(offers).toHaveCount(3);
  await expect(offers.filter({ hasText: "Your lead VC, back from the last round." })).toContainText(name);
  await expect(student.getByTestId("ipo-seriesB")).toHaveAttribute("data-met", "true");

  // Declining all three: three new VCs will come for the same round.
  await panel.getByTestId("vc-decline-all").click();
  await expect(panel.getByTestId("vc-coming")).toContainText("Three new VCs will approach for Series B in a few days");
});
