import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Named to run after smoke.spec.ts, whose first test takes the oldest login code.

test("migrating from IaaS to PaaS quotes the new setup item by item, then shows both setups during the move", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Setup Movers", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  const panel = student.getByTestId("migration-panel");
  await panel.locator("label.choice", { hasText: "Deploy to a platform (PaaS)" }).click();
  await student.getByRole("button", { name: "Plan migration" }).click();

  // 1,000 social users need 3 CU and 4 DBU; with a quarter more room, one instance and a small managed database.
  const setup = student.getByTestId("quote-setup");
  await expect(setup).toContainText("sized to today's demand (3.75 CU, 5 DBU) with 25% room to grow");
  await expect(setup.locator("tbody tr")).toHaveCount(2);
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("1 × app instance");
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("15 CU each");
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("£800");
  await expect(setup.locator('[data-setup-item="database-small"]')).toContainText("1 × small managed database");
  await expect(setup.locator('[data-setup-item="database-small"]')).toContainText("£1,000");
  // Rented, so nothing up front: only a monthly column.
  await expect(setup.getByRole("columnheader", { name: "Up front" })).toHaveCount(0);
  await expect(student.getByTestId("quote-setup-monthly")).toHaveText("£1,800");
  // Its £1,800 a month is in the double billing, with the platform's £1,500: £110 a day for 14 days.
  await expect(student.getByTestId("quote-double")).toHaveText("£1,540");
  await expect(student.getByTestId("quote-ops")).toHaveText("1");

  await student.getByRole("button", { name: "Start migration" }).click();
  await expect(setup).toHaveCount(0);

  // Both setups side by side: the old VMs serving until the switch, and the new setup billed from day 1.
  const old = student.getByTestId("old-setup");
  const next = student.getByTestId("new-setup");
  await expect(old).toContainText("Now: Rent VMs (IaaS)");
  await expect(old).toContainText("1 × medium app server");
  await expect(old).toContainText("1 × medium database");
  await expect(next).toContainText("Next: Deploy to a platform (PaaS)");
  await expect(next.locator('[data-setup-item="app-medium"]')).toContainText("1 × app instance");
  await expect(next.locator('[data-setup-item="database-small"]')).toContainText("Ready for the switch");
  await expect(student.getByTestId("new-setup-monthly")).toHaveText("£1,800");

  // Day 1 of the move bills both.
  await student.getByRole("button", { name: "Continue" }).click();
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log).toContainText("App server (medium) rent: 1 × £550 a month");
  await expect(log).toContainText("Double billing: App instance (medium): 1 × £800 a month");
  await expect(log).toContainText("Double billing: Managed database (small): 1 × £1,000 a month");
});
