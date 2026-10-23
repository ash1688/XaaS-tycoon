import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

/** Moves a company's start date in the test database, as if it had been started then. */
async function startOn(id: string, startDate: string) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{startDate}', ${sql.json(startDate)}) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

test("the dashboard shows the date and year, the holidays coming, and a holiday announced ahead", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Calendar Shop", productType: "ecommerce", model: "saas" },
  });
  const { id } = await created.json();

  // The e2e server starts every game on 1 October 2026: no holidays in its 30 days.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("date")).toHaveText("Thursday 1 October 2026");
  await expect(student.getByTestId("calendar-date")).toContainText("1 October 2026");
  await expect(student.getByText("No more holidays before the game ends.")).toBeVisible();

  // Started on 10 November instead, Black Friday falls on day 18, and shows ahead of time with what it does to a shop.
  await startOn(id, "2026-11-10");
  await student.reload();
  await expect(student.getByTestId("date")).toHaveText("Tuesday 10 November 2026");
  await expect(student.getByTestId("holiday-next")).toHaveText("Next: Black Friday in 17 days (load ×2.2, sign-ups ×2.5).");
  await student.getByRole("button", { name: "Calendar" }).click();
  const dialog = student.getByRole("dialog", { name: "Calendar" });
  await expect(dialog.locator('[data-holiday="blackFriday"]')).toContainText("27 November to 30 November (in 17 days)");
  await expect(dialog.locator('[data-holiday="blackFriday"]')).toContainText("A huge shopping spike");
  await dialog.getByRole("button", { name: "Close" }).click();

  // Fourteen days before it, the day log announces it, and the date has moved on.
  for (let day = 2; day <= 4; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of`);
  }
  await expect(student.getByTestId("date")).toHaveText("Friday 13 November 2026");
  await expect(student.getByTestId("calendar").first()).toContainText("Black Friday is coming in 14 days");

  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  await request.delete(`/api/teacher/codes/${code}`);
});
