import { expect, test, type Browser, type APIRequestContext } from "@playwright/test";
import { E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

/** A new social network on a fresh code, opened on its Home page, with a way to read its users from the API. */
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
  const users = async () => (await (await request.get(`/api/codes/${code}/companies/${id}`)).json()).users as number;
  return Object.assign(student, { users });
}
const count = (n: number) => n.toLocaleString("en-GB");

test("on IaaS, VMs rented on day 1 bring the first users on day 2, building up over 3 days", async ({ browser, request }) => {
  const student = await newCompany(browser, request, "Launch Ltd");
  const card = student.getByTestId("launch-card");
  // No users and nothing set up yet: waiting for capacity.
  await expect(student.getByTestId("users")).toHaveText("0");
  await expect(card).toHaveAttribute("data-status", "waiting");
  await expect(student.getByTestId("launch-headline")).toHaveText("Waiting for capacity");
  await expect(student.getByTestId("launch-text")).toContainText("Nothing is set up to serve users yet");
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
    await panel.getByTestId(`size-${type}`).selectOption("medium");
    await panel.getByRole("button", { name: `Rent a medium ${name}` }).click();
    await expect(panel.getByTestId(`step-${type}-value`)).toHaveText("1 medium");
  }

  // Ready the next day, so the first users arrive then. They need an ops person: a new company has one.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(card).toHaveAttribute("data-status", "upcoming");
  await expect(student.getByTestId("launch-headline")).toHaveText("Launch in 1 day");
  await expect(student.getByTestId("launch-text")).toHaveText(
    "Your first users start arriving at the end of day 2, when your servers are ready, more each day for 3 days.",
  );
  await expect(servers).toContainText("(done)");
  await expect(student.getByTestId("launch-step-ops")).toContainText("Hire ops: 1 needed");
  await expect(student.getByTestId("launch-step-ops")).toContainText("(done)");

  // The game's launch users arrive over days 2 to 4, more each day. Home shows those who have joined, never the total.
  const ramp = [
    { day: 2, headline: "Launching: users arriving (day 1 of 3)" },
    { day: 3, headline: "Launching: users arriving (day 2 of 3)" },
    { day: 4, headline: "Launched on day 2" },
  ];
  let before = 0;
  for (const { day, headline } of ramp) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
    await expect(student.getByTestId("launch-headline")).toHaveText(headline);
    const users = await student.users();
    expect(users).toBeGreaterThan(before);
    await expect(student.getByTestId("users")).toHaveText(count(users));
    if (day < 4) {
      await expect(student.getByTestId("launch-text")).toHaveText(
        `${count(users)} users have joined so far, more on the way. Then normal growth takes over.`,
      );
    }
    before = users;
  }
  // All the launch users: 2,500 to 7,500.
  expect(before).toBeGreaterThanOrEqual(2_500);
  expect(before).toBeLessThanOrEqual(7_500);
  await expect(card).toHaveAttribute("data-status", "launched");
  await student.getByRole("button", { name: "Day log" }).click();
  // The day log has each day's arrivals; the last says the ramp is over.
  const arrivals = student.getByRole("dialog", { name: "Day log" }).getByTestId("launch");
  await expect(arrivals).toHaveCount(3);
  await expect(arrivals.filter({ hasText: "day 3 of 3" })).toHaveText(
    /^Launch, day 3 of 3: [\d,]+ new users arrived, [\d,]+ of them paying\. That's everyone: normal growth takes over from tomorrow\.$/,
  );
});

test("a company that sets nothing up waits for capacity, with no users", async ({ browser, request }) => {
  const student = await newCompany(browser, request, "Waiting Ltd");
  for (const day of [2, 3]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await expect(student.getByTestId("launch-card")).toHaveAttribute("data-status", "waiting");
  await expect(student.getByTestId("launch-headline")).toHaveText("Waiting for capacity");
  await expect(student.getByTestId("launch-text")).toContainText("Nothing is set up to serve users yet");
  await expect(student.getByTestId("launch-step-servers")).toContainText("(to do)");
  await expect(student.getByTestId("users")).toHaveText("0");
});

test("on PaaS, a managed database added from the empty state brings users from day 2", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Empty Platform Ltd", "paas");
  await expect(student.getByTestId("launch-step-servers")).toContainText("Set up app instances and a managed database");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // Nothing runs yet, and the controls say so: no instances, no database and no cache. + is there to add a database.
  const platform = student.getByTestId("platform-panel");
  await expect(platform.getByTestId("instances-value")).toHaveText("0");
  await expect(platform.getByTestId("managed-database-value")).toHaveText("None");
  await expect(platform.getByTestId("no-database")).toContainText("None yet");
  await expect(platform.getByRole("button", { name: "Remove a small database" })).toBeDisabled();
  await expect(platform.getByTestId("managed-database-why")).toHaveText("You have no database to remove.");
  await expect(platform.getByRole("button", { name: "Add a small database" })).toBeEnabled();
  await expect(platform.getByTestId("managed-cache-value")).toHaveText("None");
  // With none running, the dropdown only picks the size + adds: still nothing is running.
  await platform.getByTestId("managed-database-size").selectOption("medium");
  await expect(platform.getByTestId("managed-database-value")).toHaveText("None");
  await expect(platform.getByRole("button", { name: "Add a medium database" })).toBeEnabled();
  await platform.getByTestId("managed-database-size").selectOption("small");

  // One instance, and + adds the small database.
  await platform.getByRole("button", { name: "One more app instance" }).click();
  await expect(platform.getByTestId("instances-value")).toHaveText("1");
  await platform.getByRole("button", { name: "Add a small database" }).click();
  await expect(platform.getByTestId("managed-database-value")).toHaveText("1");
  await expect(platform.getByTestId("managed-database-summary")).toHaveText("1 × small");
  await expect(platform.getByTestId("managed-database-size")).toHaveValue("small");
  await expect(platform.getByTestId("no-database")).toHaveCount(0);
  // The cache is added with + and taken away with −.
  await platform.getByRole("button", { name: "Add a small cache" }).click();
  await expect(platform.getByTestId("managed-cache-value")).toHaveText("1");
  await platform.getByRole("button", { name: "Remove a small cache" }).click();
  await expect(platform.getByTestId("managed-cache-value")).toHaveText("None");

  for (const day of [2, 3, 4]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("launch-headline")).toHaveText("Launched on day 2");
  await expect(student.getByTestId("users")).toHaveText(count(await student.users()));
  expect(await student.users()).toBeGreaterThanOrEqual(2_500);
});
