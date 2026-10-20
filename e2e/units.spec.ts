import { expect, test } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

test("on IaaS, renting an app server and a load balancer grows the CU capacity bar after Continue", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Racks Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // A second ops person for the extra servers, so no tier is cut for missing ops.
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "hire", pool: "ops" } });

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  // Home's capacity card shows the tightest tier: the database, 4 of 15 DBU.
  await expect(student.getByTestId("home-tightest")).toContainText("DBU 27%");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The starter setup: a medium app server (15 CU) and a medium database (15 DBU), and one app server needs no
  // load balancer.
  const cu = student.getByRole("meter", { name: /^Compute \(CU\)/ });
  await expect(cu).toHaveAttribute("aria-valuemax", "15");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText("3 / 15 CU");
  const servers = student.getByTestId("servers-panel");
  await expect(servers.locator('[data-server="app-medium"]')).toContainText("App server · medium × 1");
  await expect(servers.locator('[data-server="database-medium"]')).toContainText("15 DBU");

  // Rent a large app server: the modal shows its units and price before renting.
  await student.getByTestId("rent-open").click();
  const rent = student.getByRole("dialog", { name: "Rent a VM" });
  await rent.locator('[data-rent-type="app"]').click();
  await rent.locator('[data-rent-size="large"]').click();
  await expect(rent.locator('[data-rent-size="large"]')).toContainText("20 CU");
  await expect(rent.getByTestId("rent-summary")).toContainText("20 CU for £700 a month");
  await expect(rent.getByTestId("rent-summary")).toContainText("you'll need load balancers");
  await rent.getByTestId("rent-confirm").click();
  await expect(rent).toHaveCount(0);
  await expect(servers.getByTestId("pending-app-large")).toContainText("1 setting up, ready after the next day");
  // Two app servers need a load balancer.
  await expect(student.getByTestId("lb-status")).toContainText("2 app servers need a load balancer");

  await student.getByTestId("rent-open").click();
  await rent.locator('[data-rent-type="loadBalancer"]').click();
  await rent.locator('[data-rent-size="small"]').click();
  await expect(rent.getByTestId("rent-summary")).toContainText("2 app servers for £200 a month");
  await rent.getByTestId("rent-confirm").click();
  await expect(servers.locator('[data-server="loadBalancer-small"]')).toContainText("Load balancer · small × 1");
  // Not ready yet, so the CU bar hasn't moved.
  await expect(cu).toHaveAttribute("aria-valuemax", "15");

  // Cancelling says it's pro rata. Keep it, though.
  await servers.getByRole("button", { name: "Cancel one small load balancer" }).click();
  const cancel = student.getByRole("dialog", { name: "Cancel a VM" });
  await expect(cancel.getByTestId("pro-rata-note")).toContainText("you only pay for the days you had it");
  await cancel.getByRole("button", { name: "Keep it" }).click();

  // The next day they're ready: the load balancer covers both app servers, so CU grows to 15 + 20.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(cu).toHaveAttribute("aria-valuemax", "35");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText(/ \/ 35 CU$/);
  await expect(student.getByTestId("lb-status")).toContainText("1 load balancer serves your 2 app servers");
  await expect(servers.getByTestId("pending-app-large")).toHaveCount(0);
  // Billed from the day after renting, in infrastructure.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log.locator('[data-category="infrastructure"]')).toContainText("App server (large) rent: 1 × £700 a month");
});
