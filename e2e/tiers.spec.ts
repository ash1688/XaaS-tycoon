import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch, openTiers } from "./staff.ts";

/** Gives a company research, as if its first angel had approached on day 1, with these research points banked. */
async function withResearch(id: string, points: number) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{investors,firstApproachDay}', '1'), '{researchPoints}', ${sql.json(points)}) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

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

  // Product: tier 1 is open, tier 2 waits on 7,000 users (35% of the shop's market) or a CTO, and its feature can't be
  // built yet.
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("tab", { name: "Tiers" }).click();
  const tiers = student.getByTestId("tiers");
  await expect(tiers.locator('[data-tier="1"]')).toHaveAttribute("data-open", "true");
  await expect(tiers.locator('[data-tier="2"]')).toHaveAttribute("data-open", "false");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("Users:");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("of 7,000");
  await expect(tiers.getByTestId("tier-conditions-2")).toContainText("or a CTO hired: not yet");
  await expect(tiers.getByTestId("tier-conditions-3")).toContainText(/and uptime, last \d+ days:/);
  await expect(tiers.getByTestId("tier-conditions-4")).toContainText("or every IPO condition met: not yet");
  await expect(tiers.locator('[data-tier="2"] [data-item="hardwareEfficiency1"]')).toContainText("Model benefit");
  await student.getByRole("tab", { name: "Features" }).click();
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

test("research points unlock items in an available tier, in any order, with one click on the Research page", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Unlocked Ltd", productType: "ecommerce", model: "onprem", takeLoan: true },
  });
  const { id } = await created.json();
  await launch(request, code, id, "onprem");
  // Every tier available but nothing unlocked, and 60 RP banked.
  await openTiers(id, { unlock: false });
  await withResearch(id, 60);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  const nav = student.getByRole("navigation", { name: "Game" });

  // Product: the tier 2 feature's tier is available, but it still needs unlocking.
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("tab", { name: "Features" }).click();
  await expect(student.getByTestId("feature-locked-reviews")).toHaveText("15 RP to unlock");

  // Research: tiers top to bottom, with item cards to unlock. Tier 3's feature first, then tier 2's.
  await nav.getByRole("link", { name: "Research", exact: true }).click();
  await expect(student.getByTestId("research-points")).toHaveText("60 RP");
  const tiers = student.getByTestId("tiers");
  await expect(tiers.locator('[data-tier="1"] [data-item="wishlists"]')).toContainText("Free");
  const checkout = tiers.locator('[data-item="checkout"]');
  await expect(checkout).toContainText("Feature");
  await checkout.getByRole("button", { name: "Unlock One-click checkout for 50 RP" }).click();
  await expect(checkout).toHaveAttribute("data-unlocked", "true");
  await expect(student.getByTestId("research-points")).toHaveText("10 RP");
  // 10 RP left: not enough for a 15 RP item, nor for tier 4's.
  await expect(tiers.getByRole("button", { name: "Unlock Product reviews for 15 RP" })).toBeDisabled();
  await expect(tiers.getByRole("button", { name: "Unlock Recommendations for 125 RP" })).toBeDisabled();

  // The unlocked feature can now be built, at its usual developer-days.
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("tab", { name: "Features" }).click();
  await expect(student.getByRole("button", { name: "Build One-click checkout" })).toBeVisible();
  await expect(student.getByTestId("feature-locked-reviews")).toHaveText("15 RP to unlock");
});
