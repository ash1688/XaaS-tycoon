import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("pick the shares, see the valuation and cap table, take friends and family as previewed, and turn down the grant", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);

  // The form starts on 10,000 shares and turns away a count outside 10,000 to 100,000.
  const shares = student.getByLabel("Shares in issue");
  await expect(shares).toHaveValue("10000");
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Equity Ltd");
  await shares.fill("500");
  await expect(student.getByTestId("shares-error")).toContainText("10,000 to 100,000");
  await expect(student.getByRole("button", { name: "Start company" })).toBeDisabled();
  await shares.fill("20000");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Equity Ltd" })).toBeVisible();

  // Finance: the student owns all 20,000 shares, and the valuation shows what's pushing it up or down.
  await goTo(student, "Finance");
  const capTable = student.getByTestId("cap-table");
  await expect(capTable.getByTestId("shares-in-issue")).toHaveText("20,000");
  await expect(capTable.getByTestId("cap-student").getByTestId("cap-share")).toHaveText("100%");
  const valuation = student.getByTestId("valuation-panel");
  await expect(valuation.getByTestId("your-share")).toHaveText("100%");
  for (const driver of ["revenue", "growth", "satisfaction", "uptime", "payingUsers", "netCash"]) {
    await expect(valuation.getByTestId(`driver-${driver}`)).toBeVisible();
  }

  // Friends and family's offer previews the new shares and the dilution; accepting makes the cap table match it.
  const url = student.url().replace(/\/finance$/, "");
  const id = url.split("/").at(-1)!;
  const { funding } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const offer = funding.friendsAndFamilyOffer;
  const pct = (share: number) => `${(Math.round(share * 1000) / 10).toLocaleString("en-GB")}%`;
  await student.getByTestId("ff-review").click();
  const modal = student.getByRole("dialog", { name: "Friends and family offer" });
  await expect(modal.getByTestId("ff-their-share")).toHaveText(pct(offer.theirShare));
  await expect(modal.getByTestId("ff-your-share")).toHaveText(`100% → ${pct(offer.yourShareAfter)}`);
  await modal.getByTestId("funding-accept").click();
  await expect(modal).toBeHidden();
  await expect(capTable.getByTestId("shares-in-issue")).toHaveText((20_000 + offer.newShares).toLocaleString("en-GB"));
  await expect(capTable.getByTestId("cap-student").getByTestId("cap-share")).toHaveText(pct(offer.yourShareAfter));
  await expect(capTable.getByTestId("cap-friendsAndFamily").getByTestId("cap-share")).toHaveText(pct(offer.theirShare));
  await expect(student.getByTestId("ff-taken")).toContainText(`${offer.newShares.toLocaleString("en-GB")} shares`);
  await expect(student.getByTestId("ff-review")).toBeHidden();

  // The grant shows its condition before it's answered; declining it is for good.
  await student.getByTestId("grant-review").click();
  const grant = student.getByRole("dialog", { name: "Grant offer" });
  await expect(grant.getByTestId("grant-preview")).toContainText("Keep uptime at 99% or more for the 60 days");
  await expect(grant.getByTestId("grant-preview")).toContainText("withdrawn");
  await grant.getByTestId("funding-decline").click();
  await expect(grant).toBeHidden();
  await expect(student.getByTestId("grant-status")).toHaveText("Declined");
  await expect(student.getByTestId("grant-review")).toBeHidden();

  // Tidy up, so later tests start with an empty dashboard: deleting the code deletes the game and its logs.
  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
