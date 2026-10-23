import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

// Each test's code, deleted after it with its games, so later tests start with an empty dashboard.
let tidy: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  await tidy?.();
  tidy = undefined;
});

async function newCode(browser: Browser) {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  tidy = async () => {
    expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
  };
  return code;
}

test("a social network's reports go unhandled without moderators, and moderators are hired from Customers", async ({
  browser,
  request,
}) => {
  const code = await newCode(browser);

  // A social network on SaaS starts with no moderators: once its users arrive, nobody handles their reports.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Chatter Ltd", productType: "social", model: "saas" },
  });
  const { id } = await created.json();
  await launch(request, code, id, "saas");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`4 of ${E2E_FINAL_DAY}`);

  // Customers shows the reports, none handled, and the lawsuit odds up.
  await goTo(student, "Customers");
  const moderation = student.getByTestId("moderation");
  await expect(moderation.getByTestId("reports-today")).not.toHaveText("0");
  await expect(moderation.getByTestId("reports-handled")).toHaveText("0");
  await expect(moderation.getByTestId("reports-backlog")).not.toHaveText("0");
  await expect(moderation.getByTestId("lawsuit-odds")).not.toHaveText("×1.0");
  await expect(moderation.getByTestId("moderators-needed")).toContainText("A mid handles 60 reports a day");

  // Hire a junior moderator from there: juniors start in 3 days.
  await moderation.getByRole("radio", { name: "Junior" }).check();
  await moderation.getByRole("button", { name: "Hire one junior moderator" }).click();
  await expect(moderation.getByTestId("moderators-hiring")).toContainText("1 junior hired");

  // People lists moderators as a fourth pool, with the reports they're needed for.
  await goTo(student, "People");
  await expect(student.locator('[data-pool="moderators"]')).toContainText("Mids: £60 each a day");
  await expect(student.getByTestId("moderators-hint")).toContainText("A mid handles 60 reports a day");
});

test("a shop has no moderators to hire and no reports", async ({ browser, request }) => {
  const code = await newCode(browser);
  // A shop's users post nothing, so it has no moderators to hire, and no reports.
  const shop = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Shop Ltd", productType: "ecommerce", model: "saas" },
  });
  const shopId = (await shop.json()).id;
  const refused = await request.post(`/api/codes/${code}/companies/${shopId}/actions`, { data: { type: "hire", pool: "moderators" } });
  expect(refused.status()).toBe(400);
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${shopId}`);
  await goTo(student, "People");
  await expect(student.locator('[data-pool="support"]')).toBeVisible();
  await expect(student.locator('[data-pool="moderators"]')).toHaveCount(0);
  await goTo(student, "Customers");
  await expect(student.getByTestId("support")).toBeVisible();
  await expect(student.getByTestId("moderation")).toHaveCount(0);
});
