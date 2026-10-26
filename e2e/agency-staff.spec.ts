import { expect, test, type Page } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, reachPhase } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("hire agency staff for the next day, shown apart, and see severance before letting permanent staff go", async ({
  browser,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("E-commerce platform").click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("Temps Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Temps Ltd" })).toBeVisible();
  const id = student.url().split("/").at(-1)!;

  // Hiring support opens at launch (#236): before it, People has no support panel.
  await goTo(student, "People");
  await expect(student.getByTestId("developers-count")).toBeVisible();
  await expect(student.getByTestId("support-agency-pick")).toBeHidden();
  await reachPhase(id, "launch");
  await student.reload();

  // Agency staff: 1.25× a permanent mid's £100 for half the work, from the next day, with no severance.
  await goTo(student, "People");
  await student.getByTestId("support-agency-pick").check();
  await expect(student.getByTestId("support-grade-note")).toContainText(
    "Agency mids: £125 each a day, 0.5× a mid's work, start the day after hiring, no severance.",
  );
  await student.getByRole("button", { name: "Hire one agency mid support person" }).click();
  await expect(student.getByTestId("support-hiring")).toHaveText("1 agency mid hired: starts on day 2, in 1 day.");

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await goTo(student, "People");
  // Shown apart from the permanent team, and their half a mid's work counted with it.
  await expect(student.getByTestId("support-agency")).toHaveText("Agency staff: 1 mid, £125 a day");
  await expect(student.getByTestId("support-work")).toContainText("Does the work of 1.5 mids");
  await student.getByTestId("support-agency-pick").check();
  await expect(student.getByTestId("support-agency-count")).toHaveText("1");

  // Letting agency staff go asks nothing: there's no severance.
  await student.getByRole("button", { name: "Let go one agency mid support person" }).click();
  await expect(student.getByTestId("support-agency")).toBeHidden();
  await expect(student.getByRole("dialog")).toBeHidden();

  // Permanent staff: their severance, 14 days' pay, is shown before confirming, and nothing happens until then.
  await student.locator('[data-pool="support"]').getByRole("radio", { name: "Permanent" }).check();
  await student.getByTestId("support-amount").fill("1");
  await student.getByTestId("support-let-go-many").click();
  const modal = student.getByRole("dialog", { name: "Let go 1 mid support person?" });
  await expect(modal.getByTestId("severance-cost")).toHaveText("£1,400");
  await modal.getByRole("button", { name: "Keep them" }).click();
  await expect(student.getByTestId("support-count")).toHaveText("1");
  await student.getByTestId("support-let-go-many").click();
  await modal.getByTestId("severance-confirm").click();
  await expect(modal).toBeHidden();
  await expect(student.getByTestId("support-count")).toHaveText("0");

  // Tidy up, so later tests start with an empty dashboard: deleting the code deletes the game.
  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
