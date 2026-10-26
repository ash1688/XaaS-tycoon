import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { reachPhase } from "./staff.ts";

// Finance's and Marketing's sub-tabs (playtest 1), the same as Product's: one tab at a time, kept in the URL through a
// reload and moved with the arrow keys. Finance has Overview, Valuation and Funding, then IPO in Scale (#236), and links about an offer or
// the IPO open the right one. Marketing has Overview and New campaign, then Campaigns from the first one, and no tabs
// at all while it's locked.

// An angel approaches within days of launch, as in the angel spec.
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

const nav = (page: Page) => page.getByRole("navigation", { name: "Game" });
const goTo = (page: Page, name: string) => nav(page).getByRole("link", { name, exact: true }).click();

async function playDay(page: Page) {
  const day = Number(await page.getByTestId("day").textContent().then((t) => t!.trim().split(/\s/)[0]));
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByTestId("day")).not.toHaveText(new RegExp(`^${day}\\b`));
}

test("Finance splits into Overview, Valuation, Funding and IPO tabs, kept in the URL and moved with the arrow keys", async ({
  browser,
  request,
}) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Ledger Ltd", productType: "ecommerce", model: "iaas", takeLoan: true },
  });
  const { id } = await created.json();
  const game = `/play/${code}/${id}`;

  const student = await (await browser.newContext()).newPage();
  await student.goto(game);
  await goTo(student, "Finance");
  const tabs = student.getByRole("tablist", { name: "Finance" });
  // The IPO tab waits for the Scale phase.
  await expect(tabs.getByRole("tab")).toHaveText(["Overview", "Valuation", "Funding"]);
  await reachPhase(id, "scale");
  await student.reload();
  await expect(tabs.getByRole("tab")).toHaveText(["Overview", "Valuation", "Funding", "IPO"]);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await expect(student.getByTestId("cash")).toBeVisible();
  await expect(student.getByTestId("balance-sheet")).toBeVisible();
  await expect(student.getByTestId("spend")).toBeVisible();
  await expect(student.getByRole("heading", { name: "Cash over time" })).toBeVisible();
  await expect(student.getByTestId("loan-panel")).toHaveCount(0);
  await expect(student.getByTestId("ipo-panel")).toHaveCount(0);

  // A click opens a tab, and the URL keeps the one open.
  const funding = tabs.getByRole("tab", { name: "Funding" });
  await funding.click();
  await expect(funding).toHaveAttribute("aria-selected", "true");
  await expect(student).toHaveURL(`${game}/finance?tab=funding`);
  await expect(student.getByTestId("investor-panel")).toBeVisible();
  await expect(student.getByTestId("funding-panel")).toBeVisible();
  await expect(student.getByTestId("loan-panel")).toBeVisible();
  await expect(student.getByTestId("balance-sheet")).toHaveCount(0);

  // The arrow keys move along the tabs, wrapping at either end.
  await funding.focus();
  await student.keyboard.press("ArrowRight");
  const ipo = tabs.getByRole("tab", { name: "IPO" });
  await expect(ipo).toHaveAttribute("aria-selected", "true");
  await expect(ipo).toBeFocused();
  await expect(student.getByTestId("ipo-panel")).toBeVisible();
  await student.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Overview" })).toBeFocused();
  await student.keyboard.press("ArrowLeft");
  await expect(ipo).toBeFocused();
  await student.keyboard.press("Home");
  await student.keyboard.press("ArrowRight");
  const valuation = tabs.getByRole("tab", { name: "Valuation" });
  await expect(valuation).toBeFocused();
  await expect(student.getByTestId("cap-table")).toBeVisible();
  await expect(student.getByTestId("valuation-panel")).toBeVisible();

  // A reload keeps the tab; one the page doesn't have opens Overview.
  await student.reload();
  await expect(valuation).toHaveAttribute("aria-selected", "true");
  await student.goto(`${game}/finance?tab=nope`);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");

  // The opening bell page, before the company can float, sends the student to the IPO checklist.
  await student.goto(`${game}/ipo`);
  await student.getByRole("link", { name: "Open Finance" }).click();
  await expect(student).toHaveURL(`${game}/finance?tab=ipo`);
  await expect(ipo).toHaveAttribute("aria-selected", "true");
  await expect(student.getByTestId("ipo-panel")).toBeVisible();
});

test("an angel's offer links to Finance's Funding tab, and Marketing opens with its own tabs", async ({ browser, request }) => {
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
  await student.getByLabel("Company name").fill("Tabs Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText(/^1 of/);
  const game = new URL(student.url()).pathname;

  // Locked, Marketing is only its message, with no tabs.
  await student.goto(`${game}/marketing`);
  await expect(student.getByTestId("marketing-locked")).toBeVisible();
  await expect(student.getByRole("tablist", { name: "Marketing" })).toHaveCount(0);

  const note = student.getByTestId("investor-note");
  for (let i = 0; i < 10 && !(await note.isVisible()); i++) await playDay(student);
  await expect(note).toBeVisible();

  // From Overview, the note's link lands on the Funding tab, with the offer; there the note says it's below.
  await student.goto(`${game}/finance`);
  await expect(student.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
  await note.getByRole("link", { name: "See their offer on Finance" }).click();
  await expect(student).toHaveURL(`${game}/finance?tab=funding`);
  await expect(student.getByRole("tab", { name: "Funding" })).toHaveAttribute("aria-selected", "true");
  await expect(student.getByTestId("investor-panel").getByTestId("angel-offer")).toContainText("wants to invest");
  await expect(note).toContainText("Their offer is below.");
  // While it waits, Finance in the nav goes to Funding too.
  await goTo(student, "Home");
  await goTo(student, "Finance");
  await expect(student).toHaveURL(`${game}/finance?tab=funding`);

  // Marketing is open now: Overview and New campaign, and no Campaigns tab before the first campaign.
  await goTo(student, "Marketing");
  const tabs = student.getByRole("tablist", { name: "Marketing" });
  await expect(tabs.getByRole("tab")).toHaveText(["Overview", "New campaign"]);
  await expect(student.getByTestId("marketing")).toContainText("Marketers");
  await expect(student.getByTestId("campaign-new")).toHaveCount(0);
  const form = tabs.getByRole("tab", { name: "New campaign" });
  await form.click();
  await expect(student).toHaveURL(`${game}/marketing?tab=new`);
  await expect(student.getByTestId("campaign-new")).toBeVisible();
  await expect(student.getByTestId("marketing")).toHaveCount(0);
  await form.focus();
  await student.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Overview" })).toBeFocused();
  await expect(student.getByTestId("marketing")).toBeVisible();
  // Asked for before there's a campaign, Campaigns opens Overview.
  await student.goto(`${game}/marketing?tab=campaigns`);
  await expect(tabs.getByRole("tab", { name: "Overview" })).toHaveAttribute("aria-selected", "true");
});
