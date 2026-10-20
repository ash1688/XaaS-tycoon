import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Every spec shares the e2e database, so however this test ends, the config goes back to the defaults and its code
// and games go. Other specs pick the newest code from the list, and expect a fresh one.
let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  await request.post("/api/teacher/config/reset");
  if (code) await request.delete(`/api/teacher/codes/${code}`);
});

test("the teacher changes starting cash: new games use it, a game already started doesn't", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  // A game started on the defaults: £250,000 less IaaS's £2,000 upfront.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Before Ltd", productType: "social", model: "iaas" },
  });
  const before = await created.json();
  expect(before.cash).toBe(248_000);

  await teacher.getByRole("link", { name: "Game config" }).click();
  await expect(teacher.getByRole("heading", { name: "Game config" })).toBeVisible();
  await expect(teacher.getByTestId("config-note")).toContainText("Changes apply to games started from now on.");

  // Searching opens the groups with a match.
  await teacher.getByLabel("Search settings").fill("starting cash");
  const startingCash = teacher.getByLabel("Starting cash", { exact: true });
  await expect(startingCash).toHaveValue("250000");
  await expect(teacher.locator('[data-path="startingCash"]')).toContainText("Default 250,000 · 0 to 10,000,000");

  // Out of range: the server refuses it, with the error by the field.
  await startingCash.fill("-5");
  await teacher.getByRole("button", { name: "Save" }).click();
  await expect(teacher.locator('[data-path="startingCash"] .config-field-error')).toContainText("Must be from 0");
  await expect(teacher.getByRole("alert")).toContainText("1 setting needs fixing");

  // A per-field reset puts the default back.
  await teacher.getByRole("button", { name: "Reset Starting cash to its default" }).click();
  await expect(startingCash).toHaveValue("250000");

  await startingCash.fill("100000");
  await teacher.getByRole("button", { name: "Save" }).click();
  await expect(teacher.getByRole("status")).toContainText("Saved");
  await teacher.reload();
  await teacher.getByLabel("Search settings").fill("starting cash");
  await expect(teacher.getByLabel("Starting cash", { exact: true })).toHaveValue("100000");

  // The student starts a new company: it gets the new starting cash.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await expect(student.getByText("You start with £100,000.")).toBeVisible();
  await student.getByText("Social network", { exact: true }).click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("After Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "After Ltd" })).toBeVisible();
  await expect(student.getByTestId("cash")).toHaveText("£98,000");

  // The game started before keeps its numbers.
  await student.goto(`/play/${code}/${before.id}`);
  await expect(student.getByRole("heading", { name: "Before Ltd" })).toBeVisible();
  await expect(student.getByTestId("cash")).toHaveText("£248,000");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of");

  // Reset all, confirmed in a dialog, takes new games back to the defaults.
  await teacher.getByLabel("Search settings").fill("");
  await teacher.getByRole("button", { name: "Reset all" }).click();
  await teacher.getByRole("dialog", { name: "Reset every number?" }).getByRole("button", { name: "Yes, reset all" }).click();
  await expect(teacher.getByRole("status")).toContainText("back to its default");
  await student.goto(`/play/${code}`);
  await expect(student.getByText("You start with £250,000.")).toBeVisible();
});
