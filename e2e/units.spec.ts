import { expect, test } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

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
  // A second ops person for the extra servers, so no tier is cut for missing ops: a developer moved in, at once.
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "moveStaff", to: "ops" } });
  // A first setup rented on day 1: the social network's 4,000 users arrive over days 2 to 4.
  await launch(request, code, id, "iaas");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  // Home's capacity card shows the tightest tier: compute, 4.8 of 10 CU (the database is as full).
  await expect(student.getByTestId("home-tightest")).toContainText("CU 48%");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The first setup: a medium app server (10 CU) and a medium database (10 DBU), and one app server needs no load
  // balancer.
  const cu = student.getByRole("meter", { name: /^Compute \(CU\)/ });
  await expect(cu).toHaveAttribute("aria-valuemax", "10");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText("4.8 / 10 CU");
  const servers = student.getByTestId("servers-panel");
  await expect(servers.locator('[data-server="app-medium"]')).toContainText("App server · medium × 1");
  await expect(servers.locator('[data-server="database-medium"]')).toContainText("10 DBU");

  // Each type has a size dropdown, on the medium the company has, and a − / + for that size. Pick large: the note says
  // what + does before pressing it, and the stepper counts the large ones.
  await expect(servers.getByTestId("size-app")).toHaveValue("medium");
  await expect(servers.getByTestId("step-app-value")).toHaveText("1 medium");
  await servers.getByTestId("size-app").selectOption("large");
  await expect(servers.getByTestId("size-app").locator('option[value="large"]')).toContainText("20 CU");
  await expect(servers.getByTestId("step-app-value")).toHaveText("0 large");
  await expect(servers.getByTestId("step-note-app")).toContainText("20 CU) for £800 a month");
  await expect(servers.getByTestId("step-note-app")).toContainText("you'll need load balancers");
  await expect(servers.getByRole("button", { name: "Cancel a large app server" })).toBeDisabled();
  await expect(servers.getByTestId("step-app-why")).toHaveText("You have no large app servers to cancel.");
  await servers.getByRole("button", { name: "Rent a large app server" }).click();
  await expect(servers.getByTestId("step-app-value")).toHaveText("1 large");
  await expect(servers.getByTestId("pending-app-large")).toContainText("1 setting up, ready after the next day");
  // Two app servers need a load balancer: said before the new one is ready, here and on Home.
  await expect(student.getByTestId("lb-status")).toContainText("2 app servers need a load balancer");
  await expect(student.getByTestId("tier-cu")).toContainText("Once your new servers are ready, 1 app server won't count");
  await expect(servers.getByTestId("server-rules")).toContainText("from 2 app servers up");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("home-capacity")).toContainText("Load balancer needed once your new servers are ready");
  await expect(student.getByTestId("home-alerts")).toContainText("Load balancer needed soon");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  await expect(servers.getByTestId("step-note-loadBalancer")).toContainText("(2 app servers) for £200 a month");
  await servers.getByRole("button", { name: "Rent a small load balancer" }).click();
  await expect(servers.locator('[data-server="loadBalancer-small"]')).toContainText("Load balancer · small × 1");
  await expect(servers.getByTestId("count-loadBalancer")).toHaveText("1 rented · 2 app servers");
  // Not ready yet, so the CU bar hasn't moved.
  await expect(cu).toHaveAttribute("aria-valuemax", "10");

  // Cancelling says it's pro rata. Keep it, though.
  await servers.getByRole("button", { name: "Cancel a small load balancer" }).click();
  const cancel = student.getByRole("dialog", { name: "Cancel a VM" });
  await expect(cancel.getByTestId("pro-rata-note")).toContainText("you only pay for the days you had it");
  await cancel.getByRole("button", { name: "Keep it" }).click();

  // The next day they're ready: the load balancer covers both app servers, so CU grows to 10 + 20.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await expect(cu).toHaveAttribute("aria-valuemax", "30");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText(/ \/ 30 CU$/);
  await expect(student.getByTestId("lb-status")).toContainText("1 load balancer serves your 2 app servers");
  await expect(servers.getByTestId("pending-app-large")).toHaveCount(0);
  // Billed from the day after renting, in infrastructure.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log.locator('[data-category="infrastructure"]')).toContainText("App server (large) rent: 1 × £800 a month");
});
