import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

const goTo = (page: Page, name: string) => page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

test("a payments app sets its fee and transaction fee in one change, and sees both income streams on Finance", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Pay Co", productType: "payments", model: "saas" },
  });
  const { id } = await created.json();
  await launch(request, code, id, "saas");
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);

  // On Product: a monthly fee and a transaction fee, judged together as a usual month per business.
  await goTo(student, "Product");
  const pricing = student.getByTestId("pricing");
  await expect(pricing.getByTestId("price")).toHaveText("£10");
  await expect(pricing.getByTestId("transaction-rate")).toHaveText("2%");
  await expect(pricing.getByTestId("monthly-cost")).toHaveText("£30");

  await student.getByRole("button", { name: "Change price" }).click();
  const dialog = student.getByRole("dialog", { name: "Set your price" });
  await expect(dialog.getByTestId("fair-price-hint")).toContainText("One change sets both");
  const fee = dialog.getByLabel("Monthly fee per paying business (£)");
  const rate = dialog.getByLabel("Transaction fee (% of every payment)");
  await expect(rate).toHaveValue("2");
  // Moving money from the fee to the transaction fee: a usual month still costs £30, so no one reacts.
  await fee.fill("0");
  await rate.fill("3");
  await expect(dialog.getByTestId("price-same-monthly")).toContainText("still costs a business £30");
  // A rise in the transaction fee alone is a rise.
  await fee.fill("10");
  await rate.fill("2.5");
  await expect(dialog.getByTestId("price-verdict")).toContainText("At £10 + 2.5%");
  await expect(dialog.getByTestId("preview-reaction")).toBeVisible();
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog).toBeHidden();
  await expect(pricing.getByTestId("transaction-rate")).toHaveText("2.5%");
  await expect(pricing.getByTestId("monthly-cost")).toHaveText("£35");
  // One lock for both.
  await expect(pricing.getByTestId("price-lock")).not.toHaveText("Unlocked");
  await expect(student.getByRole("button", { name: "Preview a price" })).toBeVisible();

  // The next day, both streams come in, and Finance shows each.
  await student.getByRole("button", { name: "Continue" }).click();
  await goTo(student, "Finance");
  const sheet = student.getByTestId("balance-sheet");
  const { payments, income } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const pounds = (n: number) => `£${n.toLocaleString("en-GB")}`;
  expect(payments.feeIncome).toBeGreaterThan(0);
  expect(payments.transactionIncome).toBeGreaterThan(0);
  expect(payments.feeIncome + payments.transactionIncome).toBe(income);
  await expect(sheet.getByTestId("balance-stream-fees")).toContainText("of which monthly fees");
  await expect(sheet.getByTestId("balance-stream-fees-total")).toHaveText(pounds(payments.feeIncome));
  await expect(sheet.getByTestId("balance-stream-transactions-total")).toHaveText(pounds(payments.transactionIncome));
  await expect(sheet.getByTestId("balance-streams-note")).toContainText("2.5% of every payment");

  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
