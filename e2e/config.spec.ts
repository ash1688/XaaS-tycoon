import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// Every spec shares the e2e database, so however a test ends, Default goes back to being active, the presets go, and
// so do its code and games. Other specs pick the newest code from the list, and expect a fresh one.
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

test("the teacher saves a preset and makes it active: new games use it, a game already started doesn't", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher);
  await teacher.getByRole("button", { name: "Create code" }).click();
  code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  // A game started on the defaults: £15,000 less IaaS's £2,000 upfront.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Before Ltd", productType: "social", model: "iaas" },
  });
  const before = await created.json();
  expect(before.cash).toBe(13_000);

  await teacher.getByRole("link", { name: "Game config" }).click();
  await expect(teacher.getByRole("heading", { name: "Game config" })).toBeVisible();
  await expect(teacher.getByTestId("config-note")).toContainText("Changes apply to games started from now on.");

  // Default is active, and read-only: its numbers can be seen but not changed.
  const presets = teacher.getByRole("list", { name: "Presets" });
  await expect(presets.locator('[data-preset="Default"]')).toContainText("Active");
  await expect(teacher.getByTestId("editing")).toContainText("Viewing “Default”");
  await teacher.getByLabel("Search settings").fill("starting cash");
  await expect(teacher.getByLabel("Starting cash", { exact: true })).toHaveAttribute("readonly");
  await expect(teacher.getByRole("button", { name: "Reset all" })).toHaveCount(0);

  // Save as a new preset, which opens it for editing.
  await teacher.getByRole("button", { name: "Save as…" }).click();
  const saveAs = teacher.getByRole("dialog", { name: "Save as a new preset" });
  await saveAs.getByLabel("Preset name").fill("Big budget");
  await saveAs.getByRole("button", { name: "Save preset" }).click();
  await expect(teacher.getByTestId("editing")).toContainText("Editing “Big budget”");
  await expect(presets.locator('[data-preset="Big budget"]')).toBeVisible();

  // Searching opens the groups with a match.
  await teacher.getByLabel("Search settings").fill("starting cash");
  const startingCash = teacher.getByLabel("Starting cash", { exact: true });
  await expect(startingCash).toHaveValue("15000");
  await expect(teacher.locator('[data-path="startingCash"]')).toContainText("Default 15,000 · 0 to 10,000,000");

  // Out of range: the server refuses it, with the error by the field.
  await startingCash.fill("-5");
  await teacher.getByRole("button", { name: "Save", exact: true }).click();
  await expect(teacher.locator('[data-path="startingCash"] .config-field-error')).toContainText("Must be from 0");
  await expect(teacher.getByRole("alert")).toContainText("1 setting needs fixing");

  // A per-field reset puts the default back.
  await teacher.getByRole("button", { name: "Reset Starting cash to its default" }).click();
  await expect(startingCash).toHaveValue("15000");

  await startingCash.fill("100000");
  await teacher.getByRole("button", { name: "Save", exact: true }).click();
  await expect(teacher.getByRole("status")).toContainText("Make “Big budget” active");

  // Made active, after confirming.
  await presets.getByRole("button", { name: "Make Big budget active" }).click();
  const activate = teacher.getByRole("dialog", { name: "Make “Big budget” active?" });
  await expect(activate).toContainText("New games will use “Big budget”");
  await activate.getByRole("button", { name: "Yes, make it active" }).click();
  await expect(presets.locator('[data-preset="Big budget"]')).toContainText("Active");
  await expect(presets.locator('[data-preset="Default"]')).not.toContainText("Active");

  // Still there after a reload, opened as the active preset.
  await teacher.reload();
  await expect(teacher.getByTestId("editing")).toContainText("Editing “Big budget”");
  await teacher.getByLabel("Search settings").fill("starting cash");
  await expect(teacher.getByLabel("Starting cash", { exact: true })).toHaveValue("100000");

  // The student starts a new company: it gets the new starting cash.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await expect(student.getByText("You start with £100,000.")).toBeVisible();
  await student.getByText("Social network", { exact: true }).click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("After Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByRole("heading", { name: "After Ltd" })).toBeVisible();
  await expect(student.getByTestId("cash")).toHaveText("£98,000");

  // The game started before keeps its numbers.
  await student.goto(`/play/${code}/${before.id}`);
  await expect(student.getByRole("heading", { name: "Before Ltd" })).toBeVisible();
  await expect(student.getByTestId("cash")).toHaveText("£13,000");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of");

  // The dashboard shows the preset each game started with, and so does the teacher's view of the game.
  await teacher.goto("/staff");
  const rows = teacher.locator(`section[data-code="${code}"] tbody tr`);
  await expect(rows.filter({ hasText: "After Ltd" }).getByTestId("live-preset")).toHaveText("Big budget");
  await expect(rows.filter({ hasText: "Before Ltd" }).getByTestId("live-preset")).toHaveText("Default");
  await teacher.getByRole("link", { name: "After Ltd" }).click();
  await expect(teacher.getByTestId("company-preset")).toHaveText("Big budget");

  // Reset all, confirmed in a dialog, takes the active preset, and so new games, back to the defaults.
  await teacher.goto("/staff/config");
  await teacher.getByRole("button", { name: "Reset all" }).click();
  await teacher.getByRole("dialog", { name: "Reset every number?" }).getByRole("button", { name: "Yes, reset all" }).click();
  await expect(teacher.getByRole("status")).toContainText("back to its default");
  await student.goto(`/play/${code}`);
  await expect(student.getByText("You start with £15,000.")).toBeVisible();
});

test("the teacher renames and deletes presets, but not Default or the active one", async ({ browser }) => {
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher);
  await teacher.goto("/staff/config");
  const presets = teacher.getByRole("list", { name: "Presets" });
  for (const name of ["Easy mode", "Lesson 3"]) {
    await teacher.getByRole("button", { name: "Save as…" }).click();
    const saveAs = teacher.getByRole("dialog", { name: "Save as a new preset" });
    await saveAs.getByLabel("Preset name").fill(name);
    await saveAs.getByRole("button", { name: "Save preset" }).click();
    await expect(presets.locator(`[data-preset="${name}"]`)).toBeVisible();
  }

  // Names are unique: the clash shows in the dialog.
  await presets.getByRole("button", { name: "Rename Lesson 3" }).click();
  const rename = teacher.getByRole("dialog", { name: "Rename “Lesson 3”" });
  await rename.getByLabel("Preset name").fill("easy MODE");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(rename).toContainText("There's already a preset called");
  await rename.getByLabel("Preset name").fill("Lesson 4");
  await rename.getByRole("button", { name: "Rename" }).click();
  await expect(presets.locator('[data-preset="Lesson 4"]')).toBeVisible();
  await expect(presets.locator('[data-preset="Lesson 3"]')).toHaveCount(0);

  // Default can't be renamed or deleted, and neither can the active preset be deleted.
  await expect(presets.getByRole("button", { name: "Rename Default" })).toHaveCount(0);
  await expect(presets.getByRole("button", { name: "Delete Default" })).toHaveCount(0);
  await presets.getByRole("button", { name: "Make Easy mode active" }).click();
  await teacher.getByRole("button", { name: "Yes, make it active" }).click();
  await expect(presets.getByRole("button", { name: "Delete Easy mode" })).toBeDisabled();

  // Deleting asks first.
  await presets.getByRole("button", { name: "Delete Lesson 4" }).click();
  const confirm = teacher.getByRole("dialog", { name: "Delete “Lesson 4”?" });
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(presets.locator('[data-preset="Lesson 4"]')).toBeVisible();
  await presets.getByRole("button", { name: "Delete Lesson 4" }).click();
  await confirm.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(presets.locator('[data-preset="Lesson 4"]')).toHaveCount(0);
  await expect(presets.locator("li")).toHaveCount(2);
});
