import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Campaigns (#115) and marketers (#180): the Marketing page opens at the first angel investor's approach, with the
// new-campaign form, disabled until a marketer is hired; a campaign runs from the next day, run by a marketer, showing
// its spend, users brought in and cost per user, and can be stopped.

// An angel approaches within days of launch, as in the angel spec.
const EARLY_ANGEL = {
  "investors.angel.targetDays": 10,
  "investors.approachDays": 1,
  "investors.retryDays": 2,
  "investors.angel.target.dailyRevenue": 100,
  "investors.angel.target.days": 1,
  // Mids start at once, so a marketer hired today can run a campaign today.
  "staffGrades.mid.leadDays": 0,
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

const nav = (page: Page) => page.getByRole("navigation", { name: "Game" });
const goTo = (page: Page, name: string) => nav(page).getByRole("link", { name, exact: true }).click();

async function playDay(page: Page) {
  const day = Number(await page.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
}

test("the Marketing page opens at the first angel approach, and a campaign runs with its spend, users and cost per user", async ({
  browser,
  request,
}) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const created = await request.post("/api/teacher/presets", { data: { name: "Early angel", overrides: EARLY_ANGEL } });
  expect(created.ok()).toBe(true);
  preset = (await created.json()).id as string;
  expect((await request.post(`/api/teacher/presets/${preset}/activate`)).ok()).toBe(true);
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Reach Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText(/^1 of/);
  await expect(nav(student).getByRole("link", { name: "Marketing", exact: true })).toBeHidden();

  const note = student.getByTestId("investor-note");
  for (let i = 0; i < 10 && !(await note.isVisible()); i++) await playDay(student);
  await expect(note).toBeVisible();

  // No marketers yet: the form is disabled, and says why.
  await goTo(student, "Marketing");
  await expect(student.getByTestId("marketers-free")).toHaveText("0 of 0 free");
  await expect(student.getByTestId("campaign-why")).toHaveText("Each campaign needs a marketer to run it: hire one on People.");
  await expect(student.getByTestId("campaign-start")).toBeDisabled();

  // People has a marketers row, permanent only. A mid hired there is flagged idle until a campaign is running.
  await goTo(student, "People");
  const marketers = student.locator('[data-pool="marketers"]');
  await expect(marketers.getByTestId("marketers-permanent-only")).toContainText("Permanent hires only");
  await expect(marketers.getByTestId("marketers-agency-pick")).toHaveCount(0);
  await marketers.getByRole("button", { name: "Hire one mid marketer" }).click();
  await expect(marketers.getByTestId("marketers-count")).toHaveText("1");
  await expect(student.getByTestId("marketers-idle")).toContainText("1 marketer isn't running a campaign");

  await goTo(student, "Marketing");
  await expect(student.getByTestId("marketers-free")).toHaveText("1 of 1 free");
  await expect(student.getByTestId("campaigns-running")).toHaveText("0 of 1");
  const form = student.getByTestId("campaign-new");
  await expect(form.getByTestId("campaign-marketer")).toHaveText("Run by a mid marketer: ×1 users per pound.");
  await form.getByLabel("Customer type").selectOption("casual");
  await form.getByLabel(/^Budget/).fill("1400");
  await form.getByLabel(/^Length in days/).fill("14");
  await expect(form.getByTestId("campaign-estimate")).toContainText("spending £100 a day");
  await form.getByRole("button", { name: "Start campaign" }).click();

  const row = student.locator("[data-campaign='1']");
  await expect(row).toHaveAttribute("data-status", "starting");
  await expect(row.getByTestId("campaign-spent")).toHaveText("£0 of £1,400");
  await expect(row.getByTestId("campaign-marketer-grade")).toHaveText("Mid");
  await expect(student.getByTestId("campaigns-running")).toHaveText("1 of 1");
  await expect(student.getByTestId("marketers-free")).toHaveText("0 of 1 free");
  await expect(student.getByTestId("campaign-start")).toBeDisabled();
  await expect(student.getByTestId("campaign-why")).toContainText("Your one marketer is running a campaign");

  await playDay(student);
  await expect(row).toHaveAttribute("data-status", "running");
  await expect(row.getByTestId("campaign-days-run")).toHaveText("1 of 14");
  await expect(row.getByTestId("campaign-spent")).toHaveText("£100 of £1,400");
  await expect(row.getByTestId("campaign-users")).toHaveText(/^[1-9]\d*$/);
  await expect(row.getByTestId("campaign-cost-per-user")).toHaveText(/^£\d+(\.\d\d)?$/);
  await expect(student.getByTestId("campaigns-spent")).toHaveText("£100");

  await row.getByRole("button", { name: "Stop the campaign for casual users" }).click();
  await expect(row).toHaveAttribute("data-status", "stopped");
  await expect(student.getByTestId("campaigns-running")).toHaveText("0 of 1");
  await expect(student.getByTestId("marketers-free")).toHaveText("1 of 1 free");
});
