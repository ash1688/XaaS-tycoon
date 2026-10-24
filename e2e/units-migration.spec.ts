import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

test("migrating from IaaS to PaaS quotes the new setup item by item, then shows both setups during the move", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Setup Movers", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Its first VMs rented on day 1: the social network's 4,000 users arrive over days 2 to 4.
  await launch(request, code, id, "iaas");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  const panel = student.getByTestId("migration-panel");
  await panel.locator("label.choice", { hasText: "Deploy to a platform (PaaS)" }).click();
  await student.getByRole("button", { name: "Plan migration" }).click();

  // 4,000 social users need 4.8 CU and 4.8 DBU; with a quarter more room (6 of each), one instance and a small
  // managed database.
  const setup = student.getByTestId("quote-setup");
  await expect(setup).toContainText("sized to today's demand (6 CU, 6 DBU) with 25% room to grow");
  await expect(setup.locator("tbody tr")).toHaveCount(2);
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("1 × app instance");
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("10 CU each");
  await expect(setup.locator('[data-setup-item="app-medium"]')).toContainText("£1,125");
  await expect(setup.locator('[data-setup-item="database-small"]')).toContainText("1 × small managed database");
  await expect(setup.locator('[data-setup-item="database-small"]')).toContainText("£1,125");
  // Rented, so nothing up front: only a monthly column.
  await expect(setup.getByRole("columnheader", { name: "Up front" })).toHaveCount(0);
  await expect(student.getByTestId("quote-setup-monthly")).toHaveText("£2,250");
  // Its £2,250 a month is in the double billing, with the platform's £1,300 and £6 a day of power and cooling: £109 a
  // day for 14 days.
  await expect(student.getByTestId("quote-double")).toHaveText("£1,750");
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
  await expect(student.getByTestId("new-setup-monthly")).toHaveText("£2,250");

  // Day 1 of the move bills both.
  await student.getByRole("button", { name: "Continue" }).click();
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log).toContainText("App server (medium) rent: 1 × £450 a month");
  await expect(log).toContainText("Double billing: App instance (medium): 1 × £1,125 a month");
  await expect(log).toContainText("Double billing: Managed database (small): 1 × £1,125 a month");
});
