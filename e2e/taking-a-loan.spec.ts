import { expect, test, type Page } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("start without a loan, take one later on worse terms, see the debt on Finance, and pay it off early", async ({
  browser,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);

  // The new-game form shows the loan's terms before choosing: £35,000 at 10%, £38,500 over its 120-day term, rounded
  // up to £321 a day. The term is the same whatever the game's length, so it runs past this short game's end.
  const terms = student.getByTestId("loan-terms");
  await expect(terms.getByTestId("loan-amount")).toHaveText("£35,000");
  await expect(terms.getByTestId("loan-daily")).toHaveText("£321");
  await expect(terms).toContainText("for 120 days, until day 121");
  await expect(terms.getByTestId("loan-total")).toHaveText("£38,520");
  await expect(student.getByTestId("start-cash")).toHaveText("You start with £15,000.");

  // On-prem's server room takes a third of the starting cash, so it can start without the loan: borrowing is a choice.
  await student.getByText("E-commerce platform").click();
  await student.locator("label.choice", { hasText: "Own servers (on-prem)" }).click();
  await expect(student.getByTestId("cant-afford")).toBeHidden();
  await student.getByTestId("take-loan").check();
  await expect(student.getByTestId("start-cash")).toHaveText("You start with £50,000, £35,000 of it borrowed.");
  await expect(student.getByTestId("cant-afford")).toBeHidden();

  // But this company starts on IaaS without one.
  await student.getByTestId("take-loan").uncheck();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("Lean Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "Lean Ltd" })).toBeVisible();
  await expect(student.getByTestId("home-loan")).toContainText("No bank loan");

  // Two days later, the loan costs more a day: a higher rate over a shorter term.
  for (let day = 2; day <= 3; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await goTo(student, "Finance");
  const panel = student.getByTestId("loan-panel");
  await expect(panel.getByTestId("loan-status")).toHaveText("None");
  await expect(student.getByTestId("balance-debt")).toHaveText("£0");
  await panel.getByTestId("loan-open").click();
  const modal = student.getByRole("dialog", { name: "Take a bank loan" });
  // Day 3: 10.4% interest, £38,640 over 119 days, rounded up to £325 a day.
  await expect(modal.getByTestId("loan-daily")).toHaveText("£325");
  await expect(modal.getByTestId("loan-interest")).toContainText("£3,675");
  await expect(modal).toContainText("10.4% of what you borrow");
  await expect(modal).toContainText("for 119 days, until day 122");
  const before = await student.getByTestId("cash").textContent();
  await modal.getByTestId("loan-confirm").click();
  await expect(modal).toBeHidden();

  await expect(panel.getByTestId("loan-status")).toHaveText("Repaying");
  await expect(panel.getByTestId("loan-borrowed")).toHaveText("£35,000");
  await expect(panel.getByTestId("loan-daily-repayment")).toHaveText("£325");
  await expect(panel).toContainText("On day 3, at 10.4%");
  const cash = (s: string | null) => Number(s!.replace(/[£,]/g, ""));
  await expect.poll(async () => cash(await student.getByTestId("cash").textContent())).toBe(cash(before) + 35_000);
  await expect(panel.getByTestId("loan-open")).toBeHidden();

  // The next day's repayment shows as debt in the balance sheet.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`4 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("balance-debt")).toHaveText("−£325");
  await expect(student.getByTestId("balance-sheet").locator(".cat-debt")).toContainText("Debt");
  // Of it, only the interest counts against profit: £3,675 of £38,675 is interest, so £31 of the £325.
  await expect(student.getByTestId("balance-principal")).toHaveText("£294");
  await expect(student.getByTestId("balance-debt-split")).toContainText("£31 is interest and £294 is paying back");
  await expect(panel.getByTestId("loan-remaining")).toHaveText(`£${(325 * 118).toLocaleString("en-GB")}`);
  await expect(panel).toContainText("118 repayments left");
  await expect(panel).toContainText("until day 122");

  // Home's cash card notes it.
  await goTo(student, "Home");
  await expect(student.getByTestId("home-loan")).toContainText("Includes a £35,000 bank loan");
  await expect(student.getByTestId("home-loan")).toContainText("£325");
  await expect(student.getByTestId("home-loan")).toContainText("until day 122");

  // Paying it off early costs what's left of the £35,000, £34,706, and saves the £3,644 of interest still to come.
  await goTo(student, "Finance");
  await expect(panel.getByTestId("loan-payoff")).toContainText("£34,706");
  await expect(panel.getByTestId("loan-payoff")).toContainText("£3,644");
  await panel.getByTestId("loan-repay-open").click();
  const payOff = student.getByRole("dialog", { name: "Pay off the bank loan" });
  await expect(payOff.getByTestId("loan-repay-cost")).toHaveText("£34,706");
  await expect(payOff.getByTestId("loan-repay-saved")).toHaveText("£3,644");
  const beforePayOff = await student.getByTestId("cash").textContent();
  await payOff.getByTestId("loan-repay-confirm").click();
  await expect(payOff).toBeHidden();
  await expect(panel.getByTestId("loan-status")).toHaveText("Repaid");
  await expect(panel.getByTestId("loan-repaid")).toContainText("early, on day 4");
  await expect.poll(async () => cash(await student.getByTestId("cash").textContent())).toBe(cash(beforePayOff) - 34_706);

  // With it repaid, the bank lends again.
  await expect(panel.getByTestId("loan-open")).toBeVisible();
});
