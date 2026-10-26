import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Product's sub-tabs (playtest 1): Price, Features and Tiers (and API on a product with one), one at a time. The open tab stays in the URL through a
// reload, and the arrow keys move along them. Tier conditions join on
// with a space and a small letter, and developer-day counts are singular at 1.

let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = null;
});

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

/** Sets how many developer-days have gone into optimisation so far. */
async function withOptimisationDays(id: string, days: number) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{optimisationDays}', ${sql.json(days)}) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

test("Product splits into Price, Features and Tiers tabs, kept in the URL and moved with the arrow keys", async ({
  browser,
  request,
}) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Tabbed Ltd", productType: "ecommerce", model: "iaas", takeLoan: true },
  });
  const { id } = await created.json();
  const game = `/play/${code}/${id}`;

  // The e2e server runs with no MVP, so Product opens on Price (with an MVP to build, Features comes first). The shop
  // sells a paid API, so it has an API tab too.
  const student = await (await browser.newContext()).newPage();
  await student.goto(game);
  await goTo(student, "Product");
  const tabs = student.getByRole("tablist", { name: "Product" });
  await expect(tabs.getByRole("tab")).toHaveText(["Price", "Features", "Tiers", "API"]);
  await expect(tabs.getByRole("tab", { name: "Price" })).toHaveAttribute("aria-selected", "true");
  await expect(student.getByRole("tabpanel", { name: "Price" })).toBeVisible();
  await expect(student.getByTestId("pricing")).toBeVisible();
  await expect(student.getByTestId("features")).toHaveCount(0);
  await expect(student.getByTestId("tiers")).toHaveCount(0);

  // A click opens a tab, and the URL keeps the one open.
  const features = tabs.getByRole("tab", { name: "Features" });
  await features.click();
  await expect(features).toHaveAttribute("aria-selected", "true");
  await expect(student).toHaveURL(`${game}/product?tab=features`);
  await expect(student.getByTestId("features")).toBeVisible();
  await expect(student.getByTestId("pricing")).toHaveCount(0);

  // The arrow keys move along the tabs.
  await features.focus();
  await student.keyboard.press("ArrowRight");
  const tiersTab = tabs.getByRole("tab", { name: "Tiers" });
  await expect(tiersTab).toHaveAttribute("aria-selected", "true");
  await expect(tiersTab).toBeFocused();
  await expect(student).toHaveURL(`${game}/product?tab=tiers`);
  // Tier 2 takes the users or a CTO; tier 4 an angel's money or every IPO condition.
  const tiers = student.getByTestId("tiers");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("or a CTO hired: not yet");
  await expect(tiers.getByTestId("tier-conditions-4")).toContainText("or every IPO condition met: not yet");

  // A reload keeps the tab.
  await student.reload();
  await expect(tiersTab).toHaveAttribute("aria-selected", "true");
  await expect(tiers).toBeVisible();

  // End goes to the last tab; ArrowRight from there wraps round to Price, and ArrowLeft back; Home goes to the first.
  await tiersTab.focus();
  await student.keyboard.press("End");
  const apiTab = tabs.getByRole("tab", { name: "API" });
  await expect(apiTab).toHaveAttribute("aria-selected", "true");
  await expect(student.getByTestId("api-panel")).toBeVisible();
  await student.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Price" })).toHaveAttribute("aria-selected", "true");
  await expect(student.getByTestId("pricing")).toBeVisible();
  await student.keyboard.press("ArrowLeft");
  await expect(apiTab).toHaveAttribute("aria-selected", "true");
  await student.keyboard.press("Home");
  await expect(student).toHaveURL(`${game}/product?tab=price`);

  // With 1 developer-day of optimisation so far, the slider says it singly.
  await withOptimisationDays(id, 1);
  await student.goto(`${game}/product?tab=features`);
  await expect(student.getByTestId("optimisation-saving")).toContainText("(1 developer-day so far");
});
