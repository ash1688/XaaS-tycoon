// Runs in the "timed" project, against a server with TIMED_FLOW=on and a short interval.
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD, E2E_TIMED_FLOW_SECONDS } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

async function newCompany(browser: Browser, request: APIRequestContext, name: string) {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name, productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  return { code: code!, id: id as string };
}

const dayOf = async (text: Promise<string>) => Number((await text).match(/^\d+/)![0]);

test("with timed flow on, days play by themselves and Pause stops them", async ({ browser, request }) => {
  const meta = await (await request.get("/api/meta")).json();
  expect(meta.timedFlow).toEqual({ enabled: true, seconds: E2E_TIMED_FLOW_SECONDS });

  const { code, id } = await newCompany(browser, request, "Clockwork Ltd");
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("day")).toContainText(`1 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("timed-status")).toContainText(`A day plays every ${E2E_TIMED_FLOW_SECONDS}s`);

  // Play from the keyboard: the countdown shows and days advance with no clicks on Continue.
  await student.getByRole("button", { name: "Play" }).focus();
  await student.keyboard.press("Enter");
  await expect(student.getByRole("timer")).toContainText("Next day in");
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(student.getByTestId("day")).toContainText(`3 of ${E2E_FINAL_DAY}`, { timeout: 10_000 });
  // Actions still work while it plays, on any page.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "People" }).click();
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("3");

  await student.getByRole("button", { name: "Pause" }).click();
  await expect(student.getByTestId("timed-status")).toContainText("Paused");
  // A request already in flight may still land, then nothing more.
  await student.waitForTimeout(1_200);
  const paused = await dayOf(student.getByTestId("day").innerText());
  await student.waitForTimeout(2_500);
  expect(await dayOf(student.getByTestId("day").innerText())).toBe(paused);

  // Continue still steps a single day while paused.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`${paused + 1} of ${E2E_FINAL_DAY}`);
});

test("timed flow stops when the game ends", async ({ browser, request }) => {
  const { code, id } = await newCompany(browser, request, "Last Orders Ltd");
  // One day from the end, as if it had played the rest already.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{day}', ${String(E2E_FINAL_DAY - 1)}::jsonb) where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("day")).toContainText(`${E2E_FINAL_DAY - 1} of ${E2E_FINAL_DAY}`);
  await student.getByRole("button", { name: "Play" }).click();
  await expect(student.getByTestId("finished-screen")).toBeVisible({ timeout: 10_000 });
  await expect(student.getByTestId("timed-flow")).toHaveCount(0);
  await expect(student.getByTestId("summary")).toBeVisible();
  // Nothing else is sent once it has ended.
  let continues = 0;
  student.on("request", (r) => r.url().endsWith("/continue") && continues++);
  await student.waitForTimeout(2_500);
  expect(continues).toBe(0);
});
