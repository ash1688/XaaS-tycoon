import { expect, test, type Browser, type APIRequestContext } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

async function newCompany(browser: Browser, request: APIRequestContext, name: string, model: string) {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, { data: { name, productType: "social", model } });
  const { id } = await created.json();
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  return student;
}

test("on PaaS, raising the instance count grows CU capacity at once, with managed services needing no ops", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Platform Co", "paas");
  // Home's capacity card shows the tightest tier: compute, 6 of 10 CU (the database is as full).
  await expect(student.getByTestId("home-tightest")).toContainText("CU 60%");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The starter setup: one medium instance (10 CU) and a small managed database (10 DBU). The load balancer is built in.
  const platform = student.getByTestId("platform-panel");
  await expect(student.getByTestId("servers-panel")).toHaveCount(0);
  await expect(platform.getByTestId("lb-builtin")).toContainText("comes with the platform, free");
  await expect(platform.getByText("Managed by provider: no ops needed")).toHaveCount(3);
  const cu = student.getByRole("meter", { name: /^Compute \(CU\)/ });
  await expect(cu).toHaveAttribute("aria-valuemax", "10");
  await expect(platform.getByTestId("instances-count")).toHaveText("1");

  // Two more instances: the CU bar grows straight away, before any Continue, and the ops needed stay at 1.
  await platform.getByTestId("instances-up").click();
  await expect(platform.getByTestId("instances-count")).toHaveText("2");
  await platform.getByTestId("instances-up").click();
  await expect(platform.getByTestId("instances-count")).toHaveText("3");
  await expect(cu).toHaveAttribute("aria-valuemax", "30");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText("6 / 30 CU");
  await expect(platform.getByTestId("platform-note")).toContainText("you need just 1 ops");

  // A bigger managed database, at once too.
  await platform.getByTestId("managed-database").selectOption("medium");
  await expect(student.getByRole("meter", { name: /^Database \(DBU\)/ })).toHaveAttribute("aria-valuemax", "25");
  await expect(platform.getByTestId("platform-cost")).toHaveText("£4,700");

  // Billed from the next day, in infrastructure: no load balancer line.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(cu).toHaveAttribute("aria-valuemax", "30");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log.locator('[data-category="infrastructure"]')).toContainText(["App instance (medium): 3 × £900 a month"]);
  await expect(log).not.toContainText("Load balancer");
});

test("on SaaS, the Infrastructure page says capacity is the provider's job and shows the per-user bill", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Storefront Co", "saas");
  await expect(student.getByTestId("home-provider")).toContainText("Unlimited");
  await expect(student.getByTestId("home-capacity")).toContainText("free ones included");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  await expect(student.getByTestId("provider-managed")).toContainText("Capacity is the provider's job");
  // 4,000 users at £0.35 a user a month.
  await expect(student.getByTestId("provider-per-user-bill")).toContainText("£1,400");
  // No servers, unit bars or platform controls.
  await expect(student.getByTestId("tier-cu")).toHaveCount(0);
  await expect(student.getByTestId("servers-panel")).toHaveCount(0);
  await expect(student.getByTestId("platform-panel")).toHaveCount(0);
});
