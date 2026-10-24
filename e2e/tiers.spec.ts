import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

test("tiers lock later features and model benefits, and the on-prem hardware slider trades capacity for risk", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Tiered Ltd", productType: "ecommerce", model: "onprem", takeLoan: true },
  });
  const { id } = await created.json();
  await launch(request, code, id, "onprem");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  const nav = student.getByRole("navigation", { name: "Game" });

  // Product: tier 1 is open, tier 2 waits on 5,000 users, and its feature can't be built yet.
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  const tiers = student.getByTestId("tiers");
  await expect(tiers.locator('[data-tier="1"]')).toHaveAttribute("data-open", "true");
  await expect(tiers.locator('[data-tier="2"]')).toHaveAttribute("data-open", "false");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("Users:");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("of 5,000");
  await expect(tiers.locator('[data-tier="2"] [data-item="hardwareEfficiency1"]')).toContainText("Model benefit");
  await expect(student.getByTestId("feature-locked-reviews")).toHaveText("Tier 2");
  await expect(student.getByRole("button", { name: "Build Wishlists" })).toBeVisible();

  // Infrastructure: on-prem's benefits are locked by tier, and each server has a hardware slider.
  await nav.getByRole("link", { name: "Infrastructure", exact: true }).click();
  const benefits = student.getByTestId("benefits");
  await expect(benefits.locator('[data-benefit="hardwareEfficiency1"]')).toContainText("Tier 2");
  await expect(benefits.getByRole("button", { name: "Buy Hardware efficiency I" })).toHaveCount(0);

  const hardware = student.getByTestId("hardware");
  const app = hardware.locator("li").filter({ hasText: "App server" }).first();
  await expect(app).toContainText("at 100%");
  const slider = app.locator('input[type="range"]');
  await slider.evaluate((el: HTMLInputElement) => {
    el.value = "150";
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(app).toContainText("at 150%");
  await expect(app).toContainText("12% chance of overheating, 4% of a crash");
});
