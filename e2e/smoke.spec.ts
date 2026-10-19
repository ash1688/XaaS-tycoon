import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

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
  await student.getByText("Social network").click();
  await student.getByText("Rent VMs (IaaS)").click();
  await student.getByRole("button", { name: "Start company" }).click();

  await expect(student.getByRole("heading", { name: "Playwright Ltd" })).toBeVisible();
  await expect(student.getByTestId("day")).toContainText("1 of 180");
  const startCash = await student.getByTestId("cash").textContent();

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  await expect(student.getByTestId("cash")).not.toHaveText(startCash!);

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText("2 of 180");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");
});
