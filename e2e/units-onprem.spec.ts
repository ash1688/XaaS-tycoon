import { expect, test } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

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
  const { id } = await created.json();
  // A large app server and database bought on day 1 arrive on day 11, and the users with them.
  const { cash, day } = await launch(request, code, id, "onprem");
  expect(day).toBe(11);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The first kit is in place, and nothing is on order now.
  const servers = student.getByTestId("servers-panel");
  await expect(servers.locator('[data-server="app-large"]')).toContainText("App server · large × 1");
  await expect(servers.getByTestId("on-order")).toContainText("Nothing on order");

  // Picking small, the note says the upfront price, running cost, units and delivery time before + buys one.
  await servers.locator('[data-size="app-small"]').click();
  await expect(servers.locator('[data-size="app-small"]')).toContainText("£400 + £30/mo");
  const note = servers.getByTestId("step-note-app");
  await expect(note).toContainText("6 CU");
  await expect(note).toContainText("£400 up front");
  await expect(note).toContainText("£30 a month");
  await expect(note).toContainText("arrives in 10 days");
  await servers.getByRole("button", { name: "Buy a small app server" }).click();
  await expect(servers.getByTestId("step-app-value")).toHaveText("1 small (1 on order)");
  // Still on order, so there's none to sell yet.
  await expect(servers.getByRole("button", { name: "Sell a small app server" })).toBeDisabled();
  await expect(servers.getByTestId("step-app-why")).toContainText("still on order");

  // Paid for at once, and on order with its days left.
  const bought = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(bought.cash).toBe(cash - 400);
  const order = servers.getByTestId("on-order").locator('[data-order="app-small"]');
  await expect(order).toContainText("App server · small");
  await expect(order).toContainText("Arrives in 10 days");
  await expect(servers.getByTestId("on-order")).toContainText("Orders can't be cancelled");

  // A day on, one fewer day to wait; Home's capacity card notes it.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`12 of ${E2E_FINAL_DAY}`);
  await expect(order).toContainText("Arrives in 9 days");

  // Selling says what you get back, at a loss. Keep it, though.
  await servers.locator('[data-size="app-large"]').click();
  await servers.getByRole("button", { name: "Sell a large app server" }).click();
  const sell = student.getByRole("dialog", { name: "Sell a server" });
  await expect(sell.getByTestId("sell-note")).toHaveText("You get £400 back (40% of the £1,000 you paid).");
  await sell.getByRole("button", { name: "Keep it" }).click();

  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("home-on-order")).toContainText("1 server on order, the next arriving in 9 days");
});
