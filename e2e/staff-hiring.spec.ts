import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

let teacher: Page;
let code: string;

test.afterEach(async () => {
  // Deleting the code deletes the game, so later tests start with an empty dashboard.
  if (code) expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});

test("hires still to start show in the counts, − cancels them first, and agency staff all go with one button", async ({
  browser,
}) => {
  teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("Hires Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Hires Ltd" })).toBeVisible();

  // No users yet, so no tickets or reports: said plainly, not "you need the work of 0".
  await goTo(student, "People");
  await expect(student.getByTestId("support-hint")).toHaveText("A mid clears 30 tickets a day. Your users aren't raising tickets yet.");
  await expect(student.getByTestId("moderators-hint")).toHaveText("A mid handles 60 reports a day. Your users aren't reporting posts yet.");

  // + shows at once: two mids starting beside the team, and on the Mid tab.
  const devs = student.locator('[data-pool="developers"]');
  await devs.getByRole("button", { name: "Hire one mid developer" }).click();
  await devs.getByRole("button", { name: "Hire one mid developer" }).click();
  await expect(devs.getByTestId("developers-hiring")).toHaveText("2 mids hired: they start on day 8, in 7 days.");
  await expect(devs.getByTestId("developers-count")).toHaveText("2");
  await expect(devs.getByTestId("developers-starting")).toHaveText("+2 starting");
  await expect(devs.getByTestId("developers-mid-starting")).toHaveText("+2");

  // − cancels a hire still to start first, free, and says so; then it lets go someone on the team.
  await expect(devs.getByTestId("developers-minus-note")).toHaveText("− cancels a mid hire still to start first, at no cost.");
  await devs.getByRole("button", { name: "Cancel hiring one mid developer" }).click();
  await expect(devs.getByTestId("developers-hiring")).toHaveText("1 mid hired: starts on day 8, in 7 days.");
  await expect(devs.getByTestId("developers-starting")).toHaveText("+1 starting");
  await expect(devs.getByTestId("developers-count")).toHaveText("2");

  // With agency picked, the permanent hire is labelled so it isn't read as an agency one.
  await devs.getByRole("radio", { name: "Agency" }).check();
  await devs.getByRole("button", { name: "Hire one agency mid developer" }).click();
  await expect(devs.getByTestId("developers-hiring")).toHaveText(
    "1 permanent mid hired: starts on day 8, in 7 days. 1 agency mid hired: starts on day 2, in 1 day.",
  );
  await expect(devs.getByTestId("developers-agency-starting")).toHaveText("+1 starting");
  await expect(devs.getByTestId("developers-agency-all")).toContainText(
    "Cancels 1 still to start. No pay to save yet: they're paid once they start.",
  );

  // The Satisfaction modal has the same bulk row as People, and a button to let agency support staff go.
  await goTo(student, "Home");
  await student.getByRole("button", { name: "Satisfaction" }).click();
  const modal = student.getByRole("dialog", { name: "Satisfaction" });
  await expect(modal.getByTestId("support-needed")).toContainText("Your users aren't raising tickets yet.");
  await modal.locator(".support-hire").first().getByRole("radio", { name: "Agency" }).check();
  await modal.getByTestId("support-amount").fill("3");
  await expect(modal.getByTestId("support-bulk")).toContainText("£375 a day for 3 agency mid support staff");
  await modal.getByTestId("support-hire-many").click();
  await expect(modal.getByTestId("support-hiring")).toHaveText("3 agency mids hired: they start on day 2, in 1 day.");
  await expect(modal.getByTestId("moderators-bulk")).toBeVisible();
  await modal.getByRole("button", { name: "Close" }).click();

  // On the day after, agency staff in two teams: one button on People lets them all go, with the pay saved.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of");
  await goTo(student, "People");
  await expect(student.getByTestId("agency-all")).toContainText("Every team's: lets go 4 on the team, saving £525 a day.");
  await student.getByTestId("support-let-go-agency").click();
  await expect(student.getByTestId("support-agency")).toBeHidden();
  await expect(student.getByTestId("agency-all")).toBeHidden();
  await expect(student.getByTestId("developers-agency-all")).toContainText("Lets go 1 on the team, saving £150 a day.");
  await student.getByTestId("developers-let-go-agency").click();
  await expect(student.getByTestId("developers-agency")).toBeHidden();
  await expect(student.getByRole("dialog")).toBeHidden();
});
