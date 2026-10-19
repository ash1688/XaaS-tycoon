import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

test("teacher creates a code, student starts a game and presses Continue", async ({ browser }) => {
  // Teacher
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");
  expect(code).toMatch(/^\d{8}$/);

  // Student, in a separate browser context (no teacher cookie)
  const student = await (await browser.newContext()).newPage();
  await student.goto("/");
  await student.getByLabel("Login code").fill("00000000");
  await student.getByRole("button", { name: "Go" }).click();
  await expect(student.getByRole("alert")).toContainText("wasn't recognised");

  await student.getByLabel("Login code").fill(code!);
  await student.getByRole("button", { name: "Go" }).click();
  await student.getByLabel("Company name").fill("Playwright Ltd");
  await expect(student.getByRole("table")).toContainText("Ops staff needed");
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByRole("button", { name: "Start company" }).click();

  await expect(student.getByRole("heading", { name: "Playwright Ltd" })).toBeVisible();
  await expect(student.getByTestId("day")).toContainText("1 of 180");
  await expect(student.getByText("You're the customer of the layer below.")).toBeVisible();
  const stack = student.getByTestId("stack");
  await expect(stack.locator('[data-layer="os"]')).toContainText("OS and patching");
  await expect(stack.locator('[data-layer="os"]')).toContainText("You");
  await expect(stack.locator('[data-layer="hardware"]')).toContainText("Provider");
  // £250,000 starting cash less IaaS's £2,000 upfront cost.
  await expect(student.getByTestId("cash")).toHaveText("£248,000");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,000");
  await expect(student.getByTestId("model-costs")).toContainText("£6,000 a month");

  // Users, uptime and load vs capacity. A social network starts with 1,000 users.
  await expect(student.getByTestId("users")).toHaveText("1,000");
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  await expect(student.getByRole("meter", { name: "Load vs capacity" })).toBeVisible();
  // IaaS is 1 ops short, so its capacity is cut.
  await expect(student.getByTestId("capacity")).toContainText("1,500 / 63,000");

  // Staff: IaaS needs 2 ops and a new company starts with 1, so it's understaffed.
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  await expect(student.getByTestId("ops-needed")).toContainText("Understaffed");
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("3");
  await expect(student.getByTestId("staff-cost")).toHaveText("£620");

  // Features: IaaS builds them in developer-days, one at a time.
  const features = student.getByTestId("features");
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "notStarted");
  await student.getByRole("button", { name: "Build Photo sharing" }).click();
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "building");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("0 of 16 developer-days");
  await expect(student.getByRole("button", { name: "Build Groups" })).toBeDisabled();

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  // £200 IaaS running costs (£6,000 a month ÷ 30) + 3 developers × £160 + 1 ops × £140.
  await expect(student.getByTestId("cash")).toHaveText("£247,180");
  const dayLog = student.getByTestId("day-log");
  await expect(dayLog.locator('[data-category="staff"]')).toContainText("Developers pay (3)");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("running costs");
  // Spend so far, split by category.
  await expect(student.getByTestId("spend-staff")).toHaveText("£620");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,200");
  await expect(student.getByTestId("spend-addons")).toHaveText("£0");
  await expect(student.getByTestId("spend-total")).toHaveText("£2,820");
  // Users grow each day; load stays well under capacity, so uptime stays at 100%.
  await expect(student.getByTestId("users")).not.toHaveText("1,000");
  await expect(student.getByTestId("users")).toHaveText(/^1,\d{3}$/);
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  // 3 developers did 3 developer-days on the build; 13 left at 3 a day is 5 days.
  await expect(student.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("5 days left with 3 developers");
  await expect(student.getByRole("progressbar", { name: "Photo sharing" })).toHaveAttribute("aria-valuenow", "3");
  await expect(dayLog).toContainText("Building Photo sharing: 3 of 16 developer-days done.");

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText("2 of 180");
  await expect(elsewhere.getByTestId("developers-count")).toHaveText("3");
  await expect(elsewhere.getByTestId("users")).not.toHaveText("1,000");
  await expect(elsewhere.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");
});

test("a company that runs out of cash goes bankrupt and can't continue", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Broke Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  // Run the company down to its last £100 in the test database, as if it had overspent for months.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{cash}', '100') where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("cash")).toHaveText("£100");
  await student.getByRole("button", { name: "Continue" }).click();

  await expect(student.getByTestId("bankrupt-screen")).toContainText("Game over");
  await expect(student.getByTestId("day-log").getByTestId("bankrupt")).toContainText("Broke Ltd is bankrupt");
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(student.getByRole("button", { name: "Hire one developer" })).toBeDisabled();

  // Still bankrupt after a reload, and the API refuses to carry on.
  await student.reload();
  await expect(student.getByTestId("bankrupt-screen")).toBeVisible();
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const again = await request.post(`/api/codes/${code}/companies/${id}/continue`);
  expect(again.status()).toBe(409);
});
