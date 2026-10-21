import { expect, test } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

test("on-prem, buying a server charges it up front and shows it on order, counting down to delivery", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    // With the bank loan, so there's cash to buy more kit.
    data: { name: "Kit Ltd", productType: "social", model: "onprem", takeLoan: true },
  });
  const { id, cash } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The starter kit is in place, and nothing is on order yet.
  const servers = student.getByTestId("servers-panel");
  await expect(servers.locator('[data-server="app-large"]')).toContainText("App server · large × 1");
  await expect(servers.getByTestId("on-order")).toContainText("Nothing on order");

  // The buy modal shows the upfront price, running cost, units and delivery time before buying.
  await student.getByTestId("buy-open").click();
  const buy = student.getByRole("dialog", { name: "Buy a server" });
  await buy.locator('[data-rent-type="app"]').click();
  await buy.locator('[data-rent-size="small"]').click();
  await expect(buy.locator('[data-rent-size="small"]')).toContainText("£400 up front");
  const summary = buy.getByTestId("buy-summary");
  await expect(summary).toContainText("6 CU");
  await expect(summary).toContainText("£400 up front");
  await expect(summary).toContainText("£30 a month");
  await expect(summary).toContainText("Delivery takes 10 days");
  await buy.getByTestId("buy-confirm").click();
  await expect(buy).toHaveCount(0);

  // Paid for at once, and on order with its days left.
  const bought = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(bought.cash).toBe(cash - 400);
  const order = servers.getByTestId("on-order").locator('[data-order="app-small"]');
  await expect(order).toContainText("App server · small");
  await expect(order).toContainText("Arrives in 10 days");
  await expect(servers.getByTestId("on-order")).toContainText("Orders can't be cancelled");

  // A day on, one fewer day to wait; Home's capacity card notes it.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(order).toContainText("Arrives in 9 days");

  // Selling says what you get back, at a loss. Keep it, though.
  await servers.getByRole("button", { name: "Sell one large app server" }).click();
  const sell = student.getByRole("dialog", { name: "Sell a server" });
  await expect(sell.getByTestId("sell-note")).toHaveText("You get £400 back (40% of the £1,000 you paid).");
  await sell.getByRole("button", { name: "Keep it" }).click();

  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("home-on-order")).toContainText("1 server on order, the next arriving in 9 days");
});
