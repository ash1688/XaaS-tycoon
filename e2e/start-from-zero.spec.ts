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
  await expect(servers).toContainText(
    "Rent your first servers: at least one app server and one database (a cache is optional; rented servers cost nothing until you launch)",
  );
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
  await expect(student.getByTestId("launch-headline")).toHaveText("Launching once your servers are ready");
  await expect(student.getByTestId("launch-text")).toHaveText(
    "Your first users start arriving at the end of the day your servers are ready, more each day for 3 days.",
  );
  await expect(servers).toContainText("(done)");
  // Hiring ops opens with the Launch phase (#236), so the step has no link to People yet.
  const ops = student.getByTestId("launch-step-ops");
  await expect(ops).toContainText("Ops: 0.4 needed to run your servers, and you have 1.");
  await expect(ops).toContainText("Hiring more opens when you press Launch");
  await expect(ops).toContainText("(done)");
  await expect(ops.getByRole("link")).toHaveCount(0);

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

test("Launch with nothing set up names what's missing, and goes ahead", async ({ browser, request }) => {
  // The e2e server has no MVP and launches by itself once servers are ready, but Launch can still be pressed.
  const student = await newCompany(browser, request, "Short Ltd");
  const card = student.getByTestId("launch-card");
  await expect(card.getByTestId("launch-missing").getByRole("listitem")).toHaveText([
    "No app server: no users can be served",
    "No database: no users can be served",
  ]);
  await card.getByRole("button", { name: "Launch anyway" }).click();
  // The Launch step: the opening price, the fair price to start, and how launch users would split at it.
  const dialog = student.getByTestId("launch-dialog");
  const fair = await student.getByTestId("launch-price-input").inputValue();
  expect(Number(fair)).toBeGreaterThan(0);
  await expect(dialog.getByTestId("band-chart")).toHaveAttribute("data-kind", "launch");
  await expect(dialog.getByTestId("band-row")).toHaveCount(5);
  await expect(dialog.getByTestId("launch-bands-summary")).toContainText("0% wouldn't join");
  // Far above the fair price, most wouldn't join; the chart and summary follow the price.
  await student.getByTestId("launch-price-input").fill("1000");
  await expect(dialog.getByTestId("launch-bands-summary")).not.toContainText(" 0% wouldn't join");
  await expect(dialog.getByRole("img", { name: /^Everyone: join paying 0/ })).toBeVisible();
  await student.getByTestId("launch-price-input").fill(fair);
  await expect(dialog.getByTestId("launch-bands-summary")).toContainText("0% wouldn't join");
  await dialog.getByTestId("launch-confirm").click();
  await expect(card).toHaveAttribute("data-status", "launching");
  await expect(student.getByTestId("launch-headline")).toHaveText("Going live on day 2");
  await expect(card.getByTestId("launch-action")).toHaveCount(0);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("launch-headline")).toHaveText("Launching: users arriving (day 1 of 3)");
  expect(await student.users()).toBeGreaterThan(0);
});

test("on PaaS, a managed database added from the empty state brings users from day 2", async ({
  browser,
  request,
}) => {
  const student = await newCompany(browser, request, "Empty Platform Ltd", "paas");
  await expect(student.getByTestId("launch-step-servers")).toContainText("Set up app instances and a managed database");
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Infrastructure", exact: true }).click();

  // Nothing runs yet, and the controls say so: no instances, no database and no cache. One button adds a database
  // at the size picked, saying what it gives and costs.
  const platform = student.getByTestId("platform-panel");
  await expect(platform.getByTestId("instances-value")).toHaveText("0");
  await expect(platform.getByTestId("no-database")).toContainText("None yet");
  await expect(platform.getByTestId("managed-database-apply")).toHaveText("Add a small database (10 DBU, £1,125 a month)");
  await expect(platform.getByTestId("managed-cache-current")).toHaveText("None");
  await expect(platform.getByRole("button", { name: "Remove the cache" })).toHaveCount(0);
  // With none running, the dropdown only picks the size the button adds: still nothing is running.
  await platform.getByTestId("managed-database-size").selectOption("medium");
  await expect(platform.getByTestId("no-database")).toBeVisible();
  await expect(platform.getByRole("button", { name: /^Add a medium database/ })).toBeEnabled();
  await platform.getByTestId("managed-database-size").selectOption("small");

  // One instance, and the button adds the small database. Then it offers the next size up, not another database.
  await platform.getByRole("button", { name: "One more app instance" }).click();
  await expect(platform.getByTestId("instances-value")).toHaveText("1");
  await platform.getByRole("button", { name: /^Add a small database/ }).click();
  await expect(platform.getByTestId("managed-database-current")).toHaveText("1 small · 10 DBU · £1,125/mo");
  await expect(platform.getByTestId("no-database")).toHaveCount(0);
  await expect(platform.getByTestId("managed-database-size")).toHaveValue("medium");
  await expect(platform.getByTestId("managed-database-apply")).toHaveText("Resize to medium (25 DBU, £2,500 a month)");
  await expect(platform.getByRole("button", { name: /Add .*database|Remove the database/ })).toHaveCount(0);
  // The cache is added with its button and taken away with Remove the cache.
  await platform.getByRole("button", { name: /^Add a small cache/ }).click();
  await expect(platform.getByTestId("managed-cache-current")).toHaveText("1 small · 10 CH · £375/mo");
  await platform.getByRole("button", { name: "Remove the cache" }).click();
  await expect(platform.getByTestId("managed-cache-current")).toHaveText("None");

  for (const day of [2, 3, 4]) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "Home", exact: true }).click();
  await expect(student.getByTestId("launch-headline")).toHaveText("Launched on day 2");
  await expect(student.getByTestId("users")).toHaveText(count(await student.users()));
  expect(await student.users()).toBeGreaterThanOrEqual(2_500);
});
