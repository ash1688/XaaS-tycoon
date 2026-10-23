import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

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

async function signIn(teacher: Page) {
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
}

test("a student picks a difficulty the teacher allows, and the game keeps it", async ({ browser }) => {
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher);
  code = await createCode(teacher);

  // By default only Normal is offered.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  const difficulties = student.getByTestId("difficulties");
  await expect(difficulties.locator("label.choice")).toHaveCount(1);
  await expect(difficulties).toContainText("Normal");
  await expect(student.getByTestId("start-cash")).toHaveText("You start with £15,000.");

  // The teacher allows Hard too, on the config page, and saves it as the active preset.
  await teacher.getByRole("link", { name: "Game config" }).click();
  await teacher.getByRole("button", { name: "Save as…" }).click();
  const saveAs = teacher.getByRole("dialog", { name: "Save as a new preset" });
  await saveAs.getByLabel("Preset name").fill("Hard allowed");
  await saveAs.getByRole("button", { name: "Save preset" }).click();
  await expect(teacher.getByTestId("editing")).toContainText("Editing “Hard allowed”");
  await teacher.getByLabel("Search settings").fill("difficulty");
  const allowHard = teacher.getByRole("checkbox", { name: "Allow Hard" });
  await expect(allowHard).not.toBeChecked();
  await expect(teacher.getByRole("checkbox", { name: "Allow Normal" })).toBeChecked();
  await allowHard.check();
  const bar = teacher.getByRole("region", { name: "Save changes" });
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const presets = teacher.getByRole("list", { name: "Presets" });
  await presets.getByRole("button", { name: "Make Hard allowed active" }).click();
  await teacher.getByRole("dialog", { name: "Make “Hard allowed” active?" }).getByRole("button", { name: "Yes, make it active" }).click();
  await expect(presets.locator('[data-preset="Hard allowed"]')).toContainText("Active");

  // The student now sees both, with Normal picked, and picks Hard: less starting cash.
  await student.reload();
  await expect(difficulties.locator("label.choice")).toHaveCount(2);
  await expect(difficulties.getByRole("radio", { name: /Normal/ })).toBeChecked();
  await difficulties.locator("label.choice", { hasText: "Hard" }).click();
  await expect(student.getByTestId("start-cash")).toHaveText("You start with £12,000.");
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "(SaaS)" }).click();
  await student.getByLabel("Company name").fill("Hard Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toContainText("1 of");

  // The company list records the game's difficulty.
  await student.goto(`/play/${code}`);
  await expect(student.locator("li", { hasText: "Hard Ltd" })).toContainText("Hard");
});
