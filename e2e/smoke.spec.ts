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
  await expect(student.getByTestId("cash")).toHaveText("£50,000");

  // Staff: IaaS needs 2 ops and a new company starts with 1, so it's understaffed.
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  await expect(student.getByTestId("ops-needed")).toContainText("Understaffed");
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("3");
  await expect(student.getByTestId("staff-cost")).toHaveText("£620");

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  // £200 IaaS running costs + 3 developers × £160 + 1 ops × £140.
  await expect(student.getByTestId("cash")).toHaveText("£49,180");
  await expect(student.getByText("Developers pay (3)")).toBeVisible();

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText("2 of 180");
  await expect(elsewhere.getByTestId("developers-count")).toHaveText("3");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");
});
