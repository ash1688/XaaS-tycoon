import { expect, test, type Browser, type APIRequestContext } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

/** A new social network on a fresh code, opened on its Home page. */
async function newCompany(browser: Browser, request: APIRequestContext, name: string, model = "iaas") {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name, productType: "social", model },
  });
  const { id } = await created.json();
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  return student;
}

test("on IaaS, VMs rented on day 1 launch the company on day 3 with its first users", async ({ browser, request }) => {
  const student = await newCompany(browser, request, "Launch Ltd");
  const card = student.getByTestId("launch-card");
  // No users and nothing set up yet: the users can come on day 3 at the earliest.
  await expect(student.getByTestId("users")).toHaveText("0");
  await expect(card).toHaveAttribute("data-status", "upcoming");
  await expect(student.getByTestId("launch-headline")).toHaveText("Launch in 2 days");
  await expect(student.getByTestId("launch-text")).toContainText("can arrive at the end of day 3");
  const servers = student.getByTestId("launch-step-servers");
  await expect(servers).toContainText("Rent your first servers: an app server and a database");
  await expect(servers).toContainText("(to do)");

  // The checklist links to Infrastructure, where the VMs are rented.
  await servers.getByRole("link", { name: "Infrastructure" }).click();
  // Each type's + rents one of the size picked: nothing is rented yet, so the stepper starts at 0.
  const panel = student.getByTestId("servers-panel");
  await expect(panel.getByTestId("no-servers")).toBeVisible();
  for (const [type, name] of [["app", "app server"], ["database", "database"]]) {
    await expect(panel.getByTestId(`step-${type}-value`)).toHaveText("0 small");
    await panel.locator(`[data-size="${type}-medium"]`).click();
    await panel.getByRole("button", { name: `Rent a medium ${name}` }).click();
    await expect(panel.getByTestId(`step-${type}-value`)).toHaveText("1 medium");
  }

  // Ready the next day, so the company launches on day 3. They need an ops person: a new company has one.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("launch-text")).toHaveText("Your first 4,000 users arrive at the end of day 3.");
  await expect(servers).toContainText("(done)");
  await expect(student.getByTestId("launch-step-ops")).toContainText("Hire ops: 1 needed");
  await expect(student.getByTestId("launch-step-ops")).toContainText("(done)");

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("launch-headline")).toHaveText("Launch in 1 day");
  await expect(student.getByTestId("users")).toHaveText("0");

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`3 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("users")).toHaveText("4,000");
  await expect(card).toHaveAttribute("data-status", "launched");
  await expect(student.getByTestId("launch-headline")).toHaveText("Launched on day 3");
  await student.getByRole("button", { name: "Day log" }).click();
  await expect(student.getByRole("dialog", { name: "Day log" }).getByTestId("launch")).toHaveText(
    "Launch day: your first 4,000 users arrived, 1,200 of them paying.",
  );
});

test("a company that sets nothing up waits for capacity after day 3", async ({ browser, request }) => {
  const student = await newCompany(browser, request, "Waiting Ltd");
  for (const day of [2, 3]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await expect(student.getByTestId("launch-card")).toHaveAttribute("data-status", "waiting");
  await expect(student.getByTestId("launch-headline")).toHaveText("Waiting for capacity");
  await expect(student.getByTestId("launch-text")).toContainText("Day 3 has passed and nothing is set up to serve users");
  await expect(student.getByTestId("users")).toHaveText("0");
});

test("on PaaS, a managed database added from the empty state launches the company on day 3", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Empty Platform Ltd", "paas");
  await expect(student.getByTestId("launch-step-servers")).toContainText("Set up app instances and a managed database");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // Nothing runs yet, and the steppers say so: no instances, no database and no cache.
  const platform = student.getByTestId("platform-panel");
  await expect(platform.getByTestId("instances-value")).toHaveText("0");
  await expect(platform.getByTestId("managed-database-value")).toHaveText("None");
  await expect(platform.getByTestId("no-database")).toContainText("None yet");
  await expect(platform.getByRole("button", { name: "Remove the database" })).toBeDisabled();
  await expect(platform.getByTestId("managed-cache-value")).toHaveText("None");

  // One instance, and + adds the smallest database.
  await platform.getByRole("button", { name: "One more app instance" }).click();
  await expect(platform.getByTestId("instances-value")).toHaveText("1");
  await platform.getByRole("button", { name: "Add a database" }).click();
  await expect(platform.getByTestId("managed-database-value")).toHaveText("small · 10 DBU · £900/mo");
  await expect(platform.getByTestId("no-database")).toHaveCount(0);
  // The cache steps up from None and back down to it.
  await platform.getByRole("button", { name: "Add a cache" }).click();
  await expect(platform.getByTestId("managed-cache-value")).toContainText("small");
  await platform.getByRole("button", { name: "Remove the cache" }).click();
  await expect(platform.getByTestId("managed-cache-value")).toHaveText("None");

  for (const day of [2, 3]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("launch-headline")).toHaveText("Launched on day 3");
  await expect(student.getByTestId("users")).toHaveText("4,000");
});
