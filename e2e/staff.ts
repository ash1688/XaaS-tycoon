import { expect, type Page } from "@playwright/test";

/**
 * Creates a login code from a signed-in staff page and returns it. The code comes from the server's reply, not the
 * table's first row: the table already lists codes from earlier tests, and until the new row lands its first row is
 * one of those, whose companies would then show up in this test.
 */
export async function createCode(teacher: Page) {
  const [response] = await Promise.all([
    teacher.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/teacher/codes",
    ),
    teacher.getByRole("button", { name: "Create code" }).click(),
  ]);
  expect(response.ok()).toBe(true);
  const { code } = (await response.json()) as { code: string };
  await expect(teacher.locator(`td[data-code="${code}"]`)).toBeVisible();
  return code;
}
