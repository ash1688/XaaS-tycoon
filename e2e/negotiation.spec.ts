import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("negotiate friends and family's offer: see the odds, counter twice, and accept the final offer", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Haggle Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Haggle Ltd" })).toBeVisible();
  await goTo(student, "Finance");

  await student.getByTestId("ff-review").click();
  const modal = student.getByRole("dialog", { name: "Friends and family offer" });
  const talks = modal.getByTestId("negotiation");
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 1 of 3");
  await expect(talks.getByTestId("counter-amount")).toHaveValue("15000");

  // A modest ask has better odds than a greedy one.
  await talks.getByTestId("counter-amount").fill("16500");
  await expect(talks.getByTestId("counter-odds")).toContainText("That asks 10% better terms: −3 on a d20");
  await expect(talks.getByTestId("odds-high")).toContainText("High roll, 20%");
  await talks.getByTestId("counter-amount").fill("21000");
  await expect(talks.getByTestId("counter-odds")).toContainText("That asks 40% better terms: −12 on a d20");
  await expect(talks.getByTestId("odds-high")).toContainText("High roll, 0%");
  await talks.getByTestId("counter-amount").fill("30000");
  await expect(talks.getByTestId("counter-error")).toContainText("the most a counter can ask is 50%");
  await expect(talks.getByTestId("funding-counter")).toBeDisabled();

  // Countering rolls the dice: the next offer stands, and after the second counter it's final.
  await talks.getByTestId("counter-amount").fill("18000");
  await talks.getByTestId("funding-counter").click();
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Offer 2 of 3");
  await expect(talks.getByTestId("negotiation-round")).toHaveCount(1);
  await expect(talks.getByTestId("negotiation-round").first()).toContainText(/You asked £18,000 for [\d.]+%\. Rolled \d+/);
  await talks.getByTestId("counter-share").fill("20");
  await talks.getByTestId("funding-counter").click();
  await expect(talks.getByTestId("negotiation-stage")).toHaveText("Final offer");
  await expect(talks.getByTestId("funding-counter")).toBeHidden();

  // Accepting takes the final offer, as it stands.
  const id = student.url().replace(/\/finance$/, "").split("/").at(-1)!;
  const { funding, cash } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const offer = funding.friendsAndFamilyOffer;
  await modal.getByTestId("funding-accept").click();
  await expect(modal).toBeHidden();
  await expect(student.getByTestId("ff-taken")).toContainText(`${offer.newShares.toLocaleString("en-GB")} shares`);
  const after = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(after.cash).toBe(cash + offer.amount);

  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
