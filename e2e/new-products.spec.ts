import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = null;
});

test("a student picks the AI assistant or games network, and SaaS prices its users for the product", async ({ browser }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  // Five products to pick from, each with its profile.
  const products = student.locator("label.choice").filter({ has: student.locator('input[name="productType"]') });
  await expect(products).toHaveCount(6);
  await expect(products.filter({ hasText: "AI assistant" })).toContainText("Very heavy GPU compute per user");
  await expect(products.filter({ hasText: "Games network" })).toContainText("Huge launch-day and holiday spikes");

  // The model table prices SaaS's per-user fee for the product picked: dearest for the assistant's GPU-hungry users.
  const saasRow = student.locator("table.compare tr", { hasText: "SaaS platform" });
  await expect(saasRow).toContainText("+ £0.35/user");
  await products.filter({ hasText: "AI assistant" }).click();
  await expect(saasRow).toContainText("+ £2.80/user");
  await products.filter({ hasText: "Games network" }).click();
  await expect(saasRow).toContainText("+ £0.88/user");

  // A games network on SaaS: its first users arrive on day 1, and Finance shows the product's per-user fee.
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Lobby Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("users")).not.toHaveText("0");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Finance", exact: true }).click();
  await expect(student.getByTestId("model-costs")).toContainText("£900 a month plus £0.88 per user");
});
