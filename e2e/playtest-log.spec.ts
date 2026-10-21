import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

test("a student's play and UI use show in the teacher's timeline and export, under a pseudonym", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // The student's company, which they play for a few days in the browser.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Logbook Ltd", productType: "social", model: "iaas" },
  });
  expect(created.status()).toBe(201);
  const { id, day: firstDay } = await created.json();
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  for (const day of [firstDay + 1, firstDay + 2, firstDay + 3]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of`);
  }

  // Then opens the price modal on Product, previews a price, and closes it without setting one.
  await student.getByRole("link", { name: "Product", exact: true }).click();
  await student.getByRole("button", { name: /Change price|Preview a price/ }).click();
  const dialog = student.getByRole("dialog", { name: "Set your price" });
  const previewed = student.waitForResponse((r) => r.url().includes("/price-preview?price=12"));
  await dialog.getByLabel("Monthly price per paying user (£)").fill("12");
  await previewed;
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();

  // The UI events go to the server in a batch: at once when the student leaves the tab.
  const sent = student.waitForResponse((r) => r.url().endsWith("/ui-events") && r.status() === 204);
  await student.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await sent;

  // The teacher opens the game's timeline from its dashboard row: game and UI events, under a pseudonym.
  await teacher.reload();
  const row = teacher.locator(`[data-code="${code}"] tr`, { hasText: "Logbook Ltd" });
  const player = (await row.getByTestId("live-timeline").innerText()).replace(/: timeline$/, "");
  expect(player).toMatch(/^Player \d+$/);
  await row.getByTestId("live-timeline").click();
  await expect(teacher.getByRole("heading", { name: `Activity: ${player}` })).toBeVisible();
  const timeline = teacher.getByTestId("timeline");
  await expect(timeline.locator('[data-type="start"]')).toHaveCount(1);
  await expect(timeline.locator('[data-type="continue"]')).toHaveCount(3);
  await expect(timeline.locator('[data-type="continue"]').last()).toContainText("cash");
  await expect(timeline.locator('[data-type="page"]', { hasText: "Visited Product" })).toHaveCount(1);
  await expect(timeline.locator('[data-type="pricePreview"]')).toContainText("Previewed £12: didn't set one");
  await expect(timeline.locator('[data-type="modal"]')).toContainText("set your price");

  // Filtered to UI events, the game's are gone.
  await timeline.getByRole("button", { name: "UI", exact: true }).click();
  await expect(timeline.locator('[data-kind="game"]')).toHaveCount(0);
  await expect(timeline.locator('[data-type="pricePreview"]')).toHaveCount(1);

  // The CSV export for the code: one row per event, by pseudonym, with no name or code in it.
  await teacher.getByRole("link", { name: "← Staff dashboard" }).click();
  const logs = teacher.getByTestId("playtest-logs");
  await logs.getByLabel("Code").fill(code);
  const [download] = await Promise.all([teacher.waitForEvent("download"), logs.getByTestId("export-csv").click()]);
  expect(download.suggestedFilename()).toMatch(/^playtest-log-\d{4}-\d{2}-\d{2}\.csv$/);
  const csv = await readFile(await download.path(), "utf8");
  const [header, ...lines] = csv.trim().split("\r\n");
  expect(header).toContain("at,player,preset,productType,kind,type,ok,error,day,cash");
  expect(lines.length).toBeGreaterThanOrEqual(7);
  expect(lines.every((l) => l.includes(`,${player},`))).toBe(true);
  expect(lines.some((l) => l.includes(",ui,pricePreview,"))).toBe(true);
  expect(csv).not.toContain("Logbook");
  expect(csv).not.toContain(code);

  // Tidy up, so later tests start with an empty dashboard: deleting the code deletes the game and its logs.
  expect((await teacher.request.delete(`/api/teacher/codes/${code}`)).ok()).toBe(true);
  expect((await teacher.request.get(`/api/teacher/companies/${id}/timeline`)).status()).toBe(404);
});
