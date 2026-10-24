import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

// Playtest polish (#164): how full the market is, and developers with nothing to do on SaaS.
const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("shows how much of its market the company has reached, and says SaaS developers only set up add-ons", async ({ browser }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Reach Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Reach Ltd" })).toBeVisible();

  await goTo(student, "Customers");
  await expect(student.getByTestId("market-reached")).toHaveText(/^\d+%$/);
  await expect(student.getByTestId("customers")).toContainText("of 40,000 users");

  await goTo(student, "People");
  await expect(student.getByTestId("developers-idle")).toContainText("On SaaS the provider builds the features");

  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
