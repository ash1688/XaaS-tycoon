import { expect, test, type Browser, type APIRequestContext } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch, withBenefit } from "./staff.ts";

async function newCompany(browser: Browser, request: APIRequestContext, name: string, model: string) {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, { data: { name, productType: "social", model } });
  const { id } = await created.json();
  // Its first setup on day 1: the social network's 4,000 users arrive over the next 3 days.
  await launch(request, code, id, model);
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  return student;
}

test("on PaaS, raising the instance count grows CU capacity at once, with managed services needing no ops", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Platform Co", "paas");
  // Home's capacity card shows the tightest tier: compute, 4.8 of 10 CU (the database is as full).
  await expect(student.getByTestId("home-tightest")).toContainText("CU 48%");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The first setup: one medium instance (10 CU) and a small managed database (10 DBU). The load balancer is built in.
  const platform = student.getByTestId("platform-panel");
  await expect(student.getByTestId("servers-panel")).toHaveCount(0);
  await expect(platform.getByTestId("lb-builtin")).toContainText("comes with the platform, free");
  await expect(platform.getByText("Managed by provider: no ops needed")).toHaveCount(3);
  const cu = student.getByRole("meter", { name: /^Compute \(CU\)/ });
  await expect(cu).toHaveAttribute("aria-valuemax", "10");
  await expect(platform.getByTestId("instances-value")).toHaveText("1");

  // Two more instances: the CU bar grows straight away, before any Continue, and the ops needed stay at 1.
  await platform.getByTestId("instances-up").click();
  await expect(platform.getByTestId("instances-value")).toHaveText("2");
  await platform.getByTestId("instances-up").click();
  await expect(platform.getByTestId("instances-value")).toHaveText("3");
  await expect(cu).toHaveAttribute("aria-valuemax", "30");
  await expect(student.getByTestId("tier-cu-figures")).toHaveText("4.8 / 30 CU");
  await expect(platform.getByTestId("platform-note")).toContainText("you need just 1 ops");

  // A bigger managed database, at once too: there's only ever one, so the size picker and Resize grow it, saying what
  // it gives and costs. It can't be removed.
  await expect(platform.getByTestId("managed-database-current")).toHaveText("1 small · 10 DBU · £1,125/mo");
  await expect(platform.getByRole("button", { name: /Add .*database|Remove the database/ })).toHaveCount(0);
  await platform.getByTestId("managed-database-size").selectOption("small");
  await expect(platform.getByTestId("managed-database-apply")).toHaveCount(0);
  await expect(platform.getByTestId("managed-database-change")).toHaveText("This is the size you run: pick another to resize it.");
  await platform.getByTestId("managed-database-size").selectOption("medium");
  // The dropdown alone changes nothing: the button does.
  await expect(platform.getByTestId("managed-database-current")).toHaveText("1 small · 10 DBU · £1,125/mo");
  await expect(platform.getByTestId("managed-database-change")).toHaveText("15 DBU more, £1,375 a month more. Ready at once.");
  await platform.getByRole("button", { name: "Resize to medium (25 DBU, £2,500 a month)" }).click();
  await expect(platform.getByTestId("managed-database-current")).toHaveText("1 medium · 25 DBU · £2,500/mo");
  await expect(student.getByRole("meter", { name: /^Database \(DBU\)/ })).toHaveAttribute("aria-valuemax", "25");
  await expect(platform.getByTestId("platform-cost")).toHaveText("£5,875");

  // Billed from the next day, in infrastructure: no load balancer line.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await expect(cu).toHaveAttribute("aria-valuemax", "30");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await student.getByRole("button", { name: "Day log" }).click();
  const log = student.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
  await expect(log.locator('[data-category="infrastructure"]')).toContainText(["App instance (medium): 3 × £1,125 a month"]);
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

test("on PaaS with managed autoscaling, the platform shows the instances, the minimum and a maximum to set (#261)", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const { id } = await (await request.post(`/api/codes/${code}/companies`, { data: { name: "Scaling Co", productType: "social", model: "paas" } })).json();
  await launch(request, code, id, "paas");
  const act = (data: object) => request.post(`/api/codes/${code}/companies/${id}/actions`, { data });
  // Set by hand to 4: with autoscaling, that's the minimum.
  expect((await act({ type: "setInstances", count: 4 })).ok()).toBe(true);
  await withBenefit(id, "paasAutoscaling");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  const scaling = student.getByTestId("platform-autoscale");
  await expect(scaling.getByTestId("autoscale-summary")).toContainText("Instances 4 (min 4, max 12).");
  await expect(scaling.getByTestId("autoscale-summary")).toContainText("1.5× yesterday's demand, never below the 4 you set");
  // The maximum can't go below the minimum; raising it is saved.
  await scaling.getByTestId("autoscale-max-up").click();
  await expect(scaling.getByTestId("autoscale-max-value")).toHaveText("13");
  await expect(scaling.getByTestId("autoscale-summary")).toContainText("(min 4, max 13)");
});
