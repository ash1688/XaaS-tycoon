import { expect, test, type Page } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
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

test("a student picks an allowed game length, and the teacher ends games for one company and a whole code", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await signIn(teacher);
  code = await createCode(teacher);

  // By default only the short game is offered.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  const lengths = student.getByTestId("game-lengths");
  await expect(lengths.locator("label.choice")).toHaveCount(1);
  await expect(lengths).toContainText(`${E2E_FINAL_DAY} days`);

  // The teacher allows a 1-year game too, on the config page, and saves it as the active preset.
  await teacher.getByRole("link", { name: "Game config" }).click();
  await teacher.getByRole("button", { name: "Save as…" }).click();
  const saveAs = teacher.getByRole("dialog", { name: "Save as a new preset" });
  await saveAs.getByLabel("Preset name").fill("Longer games");
  await saveAs.getByRole("button", { name: "Save preset" }).click();
  await expect(teacher.getByTestId("editing")).toContainText("Editing “Longer games”");
  await teacher.getByLabel("Search settings").fill("game length");
  const allowYear = teacher.getByRole("checkbox", { name: "Allow 1 year" });
  await expect(allowYear).not.toBeChecked();
  await allowYear.check();
  const bar = teacher.getByRole("region", { name: "Save changes" });
  await bar.getByRole("button", { name: "Save", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const presets = teacher.getByRole("list", { name: "Presets" });
  await presets.getByRole("button", { name: "Make Longer games active" }).click();
  await teacher.getByRole("dialog", { name: "Make “Longer games” active?" }).getByRole("button", { name: "Yes, make it active" }).click();
  await expect(presets.locator('[data-preset="Longer games"]')).toContainText("Active");

  // The student now sees both, and picks a year.
  await student.reload();
  await expect(lengths.locator("label.choice")).toHaveCount(2);
  await lengths.locator("label.choice", { hasText: "1 year" }).click();
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByLabel("Company name").fill("Year Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toContainText("1 of 365");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 365");

  // The teacher ends that one game from the dashboard.
  await teacher.getByRole("link", { name: "← Staff dashboard" }).click();
  const group = teacher.locator(`section.live-code[data-code="${code}"]`);
  await group.getByRole("button", { name: "End Year Ltd" }).click();
  await group.getByRole("button", { name: "Yes, end it" }).click();
  await expect(group.getByTestId("live-status")).toHaveText("Ended");

  // The student's next Continue shows the game is over, with its summary.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("ended-screen")).toContainText("Your teacher ended the game on day 2");
  await expect(student.getByTestId("summary")).toContainText("Ended by the teacher on day 2 of 365");

  // Two more games, then the teacher ends every game still being played under the code.
  for (const name of ["One Ltd", "Two Ltd"]) {
    const res = await request.post(`/api/codes/${code}/companies`, { data: { name, productType: "social", model: "saas" } });
    expect(res.status()).toBe(201);
  }
  await teacher.reload();
  await group.getByRole("button", { name: `End every game under code` }).click();
  await expect(group.getByRole("group")).toContainText("End the 2 companies still being played");
  await group.getByRole("button", { name: "Yes, end them" }).click();
  await expect(group.getByTestId("live-status")).toHaveText(["Ended", "Ended", "Ended"]);
  await expect(group.getByRole("button", { name: /^End / })).toHaveCount(0);
});
