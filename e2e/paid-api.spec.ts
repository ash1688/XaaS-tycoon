import { expect, test } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

test("a shop buys its paid API, serves calls from API servers, and switches an app server to APIU and back", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Api Shop", productType: "ecommerce", model: "iaas" },
  });
  const { id } = await created.json();
  await launch(request, code, id, "iaas");
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  const nav = student.getByRole("navigation", { name: "Game" });

  // On the Product page's API tab: the Shop API, for sale.
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("tab", { name: "API" }).click();
  const panel = student.getByTestId("api-panel");
  await expect(panel.getByRole("heading", { name: "Shop API" })).toBeVisible();
  await expect(panel.getByTestId("api-pitch")).toContainText("1 APIU serves 1,000 calls a day");
  await panel.getByTestId("buy-api").click();
  // Bought: 2,000 calls a day and no APIU to serve them.
  await expect(panel.getByTestId("api-calls")).toHaveText("2,000");
  await expect(panel.getByTestId("api-apiu")).toHaveText("0");
  await expect(panel.getByTestId("api-full")).toContainText("Dropping calls");

  // On Infrastructure: API servers to rent, and the app server can switch to APIU and back.
  await nav.getByRole("link", { name: "Infrastructure", exact: true }).click();
  const servers = student.getByTestId("servers-panel");
  await expect(servers.getByTestId("apiu-rule")).toContainText("trades user capacity for API capacity");
  await servers.getByTestId("switch-apiu-medium").click();
  await expect(servers.getByTestId("switched-medium")).toContainText("1 switched to APIU");
  await expect(servers.getByTestId("count-app")).toContainText("10 APIU");
  await servers.getByTestId("switch-cu-medium").click();
  await expect(servers.getByTestId("switched-medium")).toHaveCount(0);
  await servers.getByTestId("step-api-up").click();
  await expect(servers.getByTestId("count-api")).toContainText("1 rented · 6 APIU");

  // Ready after the next day, it serves the day after: 2,000 calls fit in its 6 APIU.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("5 of");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("6 of");
  await nav.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("tab", { name: "API" }).click();
  await expect(panel.getByTestId("api-apiu")).toHaveText("6");
  await expect(panel.getByTestId("api-dropped")).toHaveCount(0);
  await expect(panel.getByTestId("api-served")).not.toHaveText("0");

  // Tidy up, so later tests start with an empty dashboard: deleting the code deletes the game.
  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
});
