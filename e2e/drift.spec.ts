import { expect, test } from "@playwright/test";
import { defaultConfig } from "@xaas/sim";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch } from "./staff.ts";

// Every spec shares the e2e database, so however a test ends, Default goes back to being active, the presets go, and
// so do its code and games.
let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const { presets } = await (await request.post("/api/teacher/presets/default/activate")).json();
  for (const p of presets) if (!p.builtIn) await request.delete(`/api/teacher/presets/${p.id}`);
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = null;
});

/** Moves a game to the eve of `day`, with its app server (id 1) one day short of the wear warning. */
async function eveOfWithWornServer(id: string, day: number) {
  const wear = defaultConfig.hardware.lifespan * defaultConfig.hardware.warnAt - 0.5;
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{day}', ${sql.json(day - 1)}) where id = ${id}`;
    await sql`update companies set state = jsonb_set(state, '{servers,0,wear}', ${sql.json(wear)}) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

test("a long game's year's end raises prices and pauses, and a nearly worn-out server is warned about", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  code = await createCode(teacher);

  // A preset that allows games until IPO.
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  const preset = await request.post("/api/teacher/presets", { data: { name: "Long games", overrides: { "allowedGameLengths.until-ipo": 1 } } });
  expect(preset.ok()).toBe(true);
  expect((await request.post(`/api/teacher/presets/${(await preset.json()).id}/activate`)).ok()).toBe(true);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Drifting Ltd", productType: "ecommerce", model: "onprem", takeLoan: true, gameLength: "until-ipo" },
  });
  expect(created.ok()).toBe(true);
  const { id } = await created.json();
  await launch(request, code, id, "onprem");
  await eveOfWithWornServer(id, 365);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  const nav = student.getByRole("navigation", { name: "Game" });
  await nav.getByRole("link", { name: "Infrastructure", exact: true }).click();
  const drift = student.getByTestId("drift");
  await expect(drift).toContainText("Prices are as they were at the start.");
  await expect(drift.getByTestId("drift-next")).toContainText("after day 365, in 1 day");

  // The year's last day: prices rise, the clock pauses, and the app server is nearly worn out.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("pause-reasons")).toContainText("Year 1 is over: running prices rose");
  await expect(student.getByTestId("pause-reasons")).toContainText("Server #1 is nearly worn out");
  await expect(drift.getByTestId("drift-year-1")).toContainText(/Year 1 \(ended day 365\): prices rose \d/);
  await expect(drift.getByTestId("drift-level")).toContainText("new kit gives +10% units");
  await expect(drift.getByTestId("drift-next")).toContainText("after day 730");
  await expect(student.getByTestId("hardware").getByTestId("wear-warning-1")).toContainText("Nearly worn out");
});
