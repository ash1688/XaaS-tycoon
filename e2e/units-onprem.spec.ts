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
  // A large app server and database bought on day 1 arrive on day 5, and the users start arriving with them.
  const { cash, day, launch: started } = await launch(request, code, id, "onprem");
  expect(started.day).toBe(5);
  expect(day).toBe(7);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // The first kit is in place, and nothing is on order now.
  const servers = student.getByTestId("servers-panel");
  await expect(servers.locator('[data-server="app-large"]')).toContainText("App server · large × 1");
  await expect(servers.getByTestId("on-order")).toContainText("Nothing on order");

  // Picking small, the note says the upfront price with its cabling, running cost, units, rack space and delivery time
  // before + buys one.
  await servers.getByTestId("size-app").selectOption("small");
  await expect(servers.getByTestId("size-app").locator('option[value="small"]')).toContainText("£400 + £30/mo");
  const note = servers.getByTestId("step-note-app");
  await expect(note).toContainText("6 CU");
  await expect(note).toContainText("£400 plus £50 cabling up front");
  await expect(note).toContainText("takes 1U in a rack");
  await expect(note).toContainText("£30 a month");
  await expect(note).toContainText("arrives in 4 days");
  await servers.getByRole("button", { name: "Buy a small app server" }).click();
  await expect(servers.getByTestId("step-app-value")).toHaveText("1 small (1 on order)");
  // Still on order, so there's none to sell yet.
  await expect(servers.getByRole("button", { name: "Sell a small app server" })).toBeDisabled();
  await expect(servers.getByTestId("step-app-why")).toContainText("still on order");

  // Paid for at once, and on order with its days left.
  const bought = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(bought.cash).toBe(cash - 400 - 50);
  expect(bought.spend.cabling).toBeGreaterThan(0);
  const order = servers.getByTestId("on-order").locator('[data-order="app-small"]');
  await expect(order).toContainText("App server · small");
  await expect(order).toContainText("Arrives in 4 days");
  await expect(servers.getByTestId("on-order")).toContainText("Orders can't be cancelled");

  // A day on, one fewer day to wait; Home's capacity card notes it.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`8 of ${E2E_FINAL_DAY}`);
  await expect(order).toContainText("Arrives in 3 days");

  // Selling says what you get back, at a loss. Keep it, though.
  await servers.getByTestId("size-app").selectOption("large");
  await servers.getByRole("button", { name: "Sell a large app server" }).click();
  const sell = student.getByRole("dialog", { name: "Sell a server" });
  await expect(sell.getByTestId("sell-note")).toHaveText("You get £400 back (40% of the £1,000 you paid).");
  await sell.getByRole("button", { name: "Keep it" }).click();

  // Racks: the large app server and database (4U each) and the small one on order (1U) are in the server room's rack.
  const racks = student.getByTestId("racks-panel");
  await expect(racks.getByTestId("racks-used")).toHaveText("9U");
  await expect(racks.getByTestId("rack-1")).toContainText("Rack #1 · medium");
  await expect(racks.getByTestId("rack-1")).toContainText("9U of 24U used · 3 servers");
  await expect(racks.getByTestId("power-and-cooling")).toContainText("£25 a day");
  // Buying a rack charges it with its cabling, and an empty rack can be sold back.
  const before = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  await racks.getByTestId("buy-rack-small").click();
  await expect(racks.getByTestId("rack-2")).toContainText("0U of 12U used · 0 servers");
  const racked = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(racked.cash).toBe(before.cash - 300 - 50);
  await expect(racks.getByTestId("sell-rack-2")).toHaveText("Sell it for £120");

  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("home-on-order")).toContainText("1 server on order, the next arriving in 3 days");
});
