import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// The game's pages are reached through its nav bar.
const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

// The full day log opens as a modal from its card on Home. Returns the latest day in it.
async function openDayLog(page: Page) {
  await goTo(page, "Home");
  await page.getByRole("button", { name: "Day log" }).click();
  return page.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
}

test("teacher creates a code, student starts a game and presses Continue", async ({ browser }) => {
  // Teacher
  const teacher = await (await browser.newContext()).newPage();
  // A controllable clock, so the live dashboard's refresh can be run on without waiting for it.
  await teacher.clock.install();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");
  expect(code).toMatch(/^\d{8}$/);

  // Student, in a separate browser context (no teacher cookie)
  const student = await (await browser.newContext()).newPage();
  await student.goto("/");
  await student.getByLabel("Login code").fill("00000000");
  await student.getByRole("button", { name: "Go" }).click();
  await expect(student.getByRole("alert")).toContainText("wasn't recognised");

  await student.getByLabel("Login code").fill(code!);
  await student.getByRole("button", { name: "Go" }).click();
  await expect(student.getByRole("table")).toContainText("Ops staff needed");
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  // A name on the profanity list is turned away with a message by the name field.
  await student.getByLabel("Company name").fill("Big Arse Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.locator("#name-error")).toContainText("choose another company name");
  await student.getByLabel("Company name").fill("Playwright Ltd");
  await expect(student.locator("#name-error")).toBeHidden();
  await student.getByRole("button", { name: "Start company" }).click();

  await expect(student.getByRole("heading", { name: "Playwright Ltd" })).toBeVisible();
  const game = new URL(student.url()).pathname;
  await expect(student.getByTestId("day")).toContainText(`1 of ${E2E_FINAL_DAY}`);
  await expect(student.getByText("You're the customer of the layer below.")).toBeVisible();
  // Home's overview cards. £250,000 starting cash less IaaS's £2,000 upfront cost, and a social network starts with
  // 1,000 users.
  await expect(student.getByTestId("cash")).toHaveText("£248,000");
  await expect(student.getByTestId("users")).toHaveText("1,000");
  await expect(student.getByTestId("uptime")).toHaveText("100%");

  // Infrastructure: load vs capacity and the responsibility stack, on its own bookmarkable page.
  await goTo(student, "Infrastructure");
  await expect(student).toHaveURL(`${game}/infrastructure`);
  await expect(student.getByRole("link", { name: "Infrastructure", exact: true })).toHaveAttribute("aria-current", "page");
  // The teaching line stays in the shell on every page.
  await expect(student.getByText("You're the customer of the layer below.")).toBeVisible();
  const stack = student.getByTestId("stack");
  await expect(stack.locator('[data-layer="os"]')).toContainText("OS and patching");
  await expect(stack.locator('[data-layer="os"]')).toContainText("You");
  await expect(stack.locator('[data-layer="hardware"]')).toContainText("Provider");
  await expect(student.getByRole("meter", { name: "Load vs capacity" })).toBeVisible();
  // IaaS is 1 ops short, so its capacity is cut.
  await expect(student.getByTestId("capacity")).toContainText("1,500 / 63,000");

  await goTo(student, "Finance");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,000");
  await expect(student.getByTestId("model-costs")).toContainText("£6,000 a month");

  // Staff: IaaS needs 2 ops and a new company starts with 1, so it's understaffed.
  await goTo(student, "People");
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  await expect(student.getByTestId("ops-needed")).toContainText("Understaffed");
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("3");
  await expect(student.getByTestId("staff-cost")).toHaveText("£620");

  // Features: IaaS builds them in developer-days, one at a time.
  await goTo(student, "Product");
  const features = student.getByTestId("features");
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "notStarted");
  await student.getByRole("button", { name: "Build Photo sharing" }).click();
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "building");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("0 of 16 developer-days");
  await expect(student.getByRole("button", { name: "Build Groups" })).toBeDisabled();

  // Timed flow is off by default: only the Continue button, no Play/Pause or countdown.
  await expect(student.getByTestId("timed-flow")).toHaveCount(0);
  await expect(student.getByRole("button", { name: "Play" })).toHaveCount(0);
  // Continue is in the nav bar, so it plays the day from any page, here Product.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student).toHaveURL(`${game}/product`);
  // 3 developers did 3 developer-days on the build; 13 left at 3 a day is 5 days.
  await expect(student.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("5 days left with 3 developers");
  await expect(student.getByRole("progressbar", { name: "Photo sharing" })).toHaveAttribute("aria-valuenow", "3");

  // Spend so far, split by category.
  await goTo(student, "Finance");
  await expect(student.getByTestId("spend-staff")).toHaveText("£620");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,200");
  await expect(student.getByTestId("spend-addons")).toHaveText("£0");
  await expect(student.getByTestId("spend-total")).toHaveText("£2,820");
  await expect(student.getByTestId("cash-chart")).toBeVisible();

  await goTo(student, "Home");
  // £200 IaaS running costs (£6,000 a month ÷ 30) + 3 developers × £160 + 1 ops × £140 out, and £40 in: 200 of the
  // social network's 1,000 users pay £6 a month.
  await expect(student.getByTestId("cash")).toHaveText("£247,220");
  // Users grow each day; load stays well under capacity, so uptime stays at 100%.
  await expect(student.getByTestId("users")).not.toHaveText("1,000");
  await expect(student.getByTestId("users")).toHaveText(/^1,\d{3}$/);
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  // The day log card has each category's total; its modal has every line.
  await expect(student.getByTestId("home-day-log").locator('[data-category="staff"]')).toContainText("£620");
  const dayLog = await openDayLog(student);
  await expect(dayLog.locator('[data-category="staff"]')).toContainText("Developers pay (3)");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("running costs");
  await expect(dayLog).toContainText("Building Photo sharing: 3 of 16 developer-days done.");
  await student.keyboard.press("Escape");
  await expect(dayLog).toHaveCount(0);

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(elsewhere.getByTestId("users")).not.toHaveText("1,000");
  await goTo(elsewhere, "People");
  await expect(elsewhere.getByTestId("developers-count")).toHaveText("3");
  // A page opens straight from its address, as a bookmark would.
  await elsewhere.goto(`${game}/product`);
  await expect(elsewhere.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");

  // The teacher's live dashboard picks the game up on its next refresh, without a reload, under its code.
  const live = teacher.getByTestId("live-dashboard");
  await expect(live).toContainText("No games in this window yet.");
  await teacher.clock.runFor(20_000);
  const row = live.locator(`[data-code="${code}"] tr`, { hasText: "Playwright Ltd" });
  await expect(row.getByTestId("live-day")).toHaveText(`2/${E2E_FINAL_DAY}`);
  await expect(row).toContainText("IaaS");
  await expect(row).toContainText("£247,220");
  await expect(row).toContainText("Active");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");

  // The teacher opens the company's summary from the dashboard.
  await teacher.getByRole("link", { name: "Playwright Ltd" }).click();
  await expect(teacher.getByRole("heading", { name: "How Playwright Ltd did" })).toBeVisible();
  await expect(teacher.getByTestId("summary")).toContainText(`So far: day 2 of ${E2E_FINAL_DAY}`);
  await expect(teacher.getByTestId("summary-cash")).toHaveText("£247,220");
  await teacher.getByRole("link", { name: "← Staff dashboard" }).click();
  await expect(teacher.getByTestId("live-dashboard")).toBeVisible();
});

test("a company that runs out of cash goes bankrupt and can't continue", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Broke Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  // Run the company down to its last £100 in the test database, as if it had overspent for months.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{cash}', '100') where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("cash")).toHaveText("£100");
  await student.getByRole("button", { name: "Continue" }).click();

  await expect(student.getByTestId("bankrupt-screen")).toContainText("Game over");
  await expect(student.getByTestId("home-day-log").getByTestId("bankrupt")).toContainText("Broke Ltd is bankrupt");
  // The game is over: Home shows the summary, Continue is off, and the pages are read-only.
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const summary = student.getByTestId("summary");
  await expect(summary).toContainText("Ran out of cash on day 2");
  await expect(student.getByTestId("summary-cash")).toHaveText(/^-£/);
  await goTo(student, "People");
  await expect(student.getByTestId("read-only")).toContainText("This game has ended");
  await expect(student.getByRole("button", { name: "Hire one developer" })).toBeDisabled();
  await goTo(student, "Home");

  // Still bankrupt after a reload, with its summary, and the API refuses to carry on.
  await student.reload();
  await expect(student.getByTestId("bankrupt-screen")).toBeVisible();
  await expect(summary).toBeVisible();
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const again = await request.post(`/api/codes/${code}/companies/${id}/continue`);
  expect(again.status()).toBe(409);
});

test("a SaaS company buys an add-on and pays for it per user", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Shopfront Ltd", productType: "social", model: "saas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await goTo(student, "Product");
  const shop = student.getByTestId("features");
  await expect(shop.getByRole("heading", { name: "Add-on shop" })).toBeVisible();
  await expect(student.getByTestId("addon-price-messaging")).toContainText("£0.08 per user a month");
  await expect(student.getByTestId("addon-bill")).toContainText("£0 a month");

  // Add-ons need a configuration team of 2 developers: with 1, they can't be bought.
  await expect(student.getByTestId("config-team")).toContainText("at least 2 developers");
  await goTo(student, "People");
  await student.getByRole("button", { name: "Let go one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("1");
  await goTo(student, "Product");
  await expect(student.getByTestId("config-team")).toContainText("Hire 1 more to buy add-ons");
  await expect(student.getByRole("button", { name: "Buy Direct messages add-on" })).toBeDisabled();
  await goTo(student, "People");
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("2");

  // Bought add-ons are active at once. 1,000 users at £0.08 is £80 a month.
  await goTo(student, "Product");
  await student.getByRole("button", { name: "Buy Direct messages add-on" }).click();
  await expect(shop.locator('[data-feature="messaging"]')).toHaveAttribute("data-status", "addon");
  await expect(shop.locator('[data-feature="messaging"]')).toContainText("Active");
  await expect(student.getByTestId("addon-bill")).toContainText("£80 a month");
  await goTo(student, "Finance");
  await expect(student.getByTestId("model-costs")).toContainText("£80 a month for add-ons");

  // A day's share of the add-on bill: £80 ÷ 30, rounded to £3, tagged add-ons.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("spend-addons")).toHaveText("£3");
  await expect((await openDayLog(student)).locator('[data-category="addons"]')).toContainText(
    "Add-on: Direct messages (1,000 users at £0.08 a month)",
  );
});

test("a company migrates from IaaS to PaaS in the background while staff keep working", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Movers Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  const panel = student.getByTestId("migration-panel");
  const stack = student.getByTestId("stack");
  await expect(panel).toContainText("0 completed");
  await expect(stack.locator('[data-layer="os"]')).toContainText("You");

  // Pick a target, see the quote, then confirm before anything starts.
  await expect(student.getByRole("button", { name: "Plan migration" })).toBeDisabled();
  await panel.locator("label.choice", { hasText: "Deploy to a platform (PaaS)" }).click();
  await student.getByRole("button", { name: "Plan migration" }).click();
  await expect(panel.getByRole("heading", { name: "Migrate to Deploy to a platform (PaaS)?" })).toBeVisible();
  const quote = student.getByTestId("migration-quote");
  await expect(quote).toContainText("You switch on day 15");
  await expect(student.getByTestId("quote-days")).toHaveText("14 days");
  // Default config: PaaS is £1,000 upfront and £300 a day; IaaS £200 a day and £3,000 to leave.
  await expect(student.getByTestId("quote-upfront")).toHaveText("£1,000");
  await expect(student.getByTestId("quote-double")).toHaveText("£4,200");
  await expect(student.getByTestId("quote-pro-rata")).toHaveText("£2,800");
  await expect(student.getByTestId("quote-exit")).toHaveText("£3,000");
  await expect(student.getByTestId("quote-total")).toHaveText("£11,000");
  await expect(student.getByTestId("quote-overrun")).toContainText("chance of 2–5 extra days");
  // Nothing has started or been charged yet.
  const company = async () => (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(await company()).toMatchObject({ migration: null, spend: { infrastructure: 2000 } });
  await student.getByRole("button", { name: "Start migration" }).click();
  await expect(quote).toHaveCount(0);

  await expect(student.getByTestId("migration-target")).toHaveText("Deploy to a platform (PaaS)");
  await expect(student.getByTestId("migration-phase")).toHaveText("Planning");
  await expect(student.getByTestId("migration-phase-days")).toHaveText("5 days left");
  await expect(student.getByTestId("migration-days-left")).toHaveText("14 days");
  await expect(student.getByTestId("stack-note")).toContainText("changes to Deploy to a platform (PaaS)");

  // Staff aren't tied up: move a developer into ops mid-migration.
  await goTo(student, "People");
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await student.getByRole("button", { name: "Move one developer to ops staff" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("1");
  await expect(student.getByTestId("ops-count")).toHaveText("2");

  const continueTo = async (day: number) => {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  };
  for (let day = 2; day <= 6; day++) await continueTo(day);
  // Still on IaaS, and billed for it, until the move completes; PaaS is billed in full on top.
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  await goTo(student, "Infrastructure");
  await expect(student.getByTestId("migration-phase")).toHaveText("Testing");
  await expect(student.getByTestId("migration-phase-days")).toHaveText("2 days left");
  await expect(student.getByTestId("migration-days-left")).toHaveText("9 days");
  await expect(panel.locator('[data-phase="planning"]')).toContainText("Done");
  let dayLog = await openDayLog(student);
  await expect(dayLog).toContainText("Planning done. Testing next, 2 days.");
  const infrastructure = dayLog.locator('[data-category="infrastructure"]');
  await expect(infrastructure).toContainText("Rent VMs (IaaS) running costs");
  await expect(infrastructure).toContainText("Double billing: Deploy to a platform (PaaS) running costs");
  await student.keyboard.press("Escape");

  // Moving starts on day 8. Seeds are random here, so it may overrun: if so, the panel shows the extra days.
  await goTo(student, "Infrastructure");
  for (let day = 7; day <= 8; day++) await continueTo(day);
  const daysLeft = Number((await student.getByTestId("migration-days-left").textContent())!.split(" ")[0]);
  if (daysLeft > 7) await expect(student.getByTestId("migration-overrun")).toContainText(`${daysLeft - 7} days`);
  else await expect(student.getByTestId("migration-overrun")).toHaveCount(0);
  for (let day = 9; day <= 8 + daysLeft; day++) await continueTo(day);
  await expect(panel).toContainText("1 completed");
  await expect(stack.locator('[data-layer="os"]')).toContainText("Provider");
  await expect(stack.locator('[data-layer="os"]')).toContainText("was You");
  await goTo(student, "People");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 1 ops staff");
  await goTo(student, "Finance");
  await expect(student.getByTestId("model-costs")).toContainText("£9,000 a month");
  dayLog = await openDayLog(student);
  await expect(dayLog).toContainText("Migration complete");
  await expect(dayLog).toContainText("Exit penalty: leaving Rent VMs (IaaS)");
});

test("a migration that overruns shows the extra days", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Slippers Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "startMigration", model: "paas" } });

  // Seeds are random, so force a 3-day overrun in the test database, as if the roll had come up.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{migration,overrunDays}', '3') where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  await expect(student.getByTestId("migration-overrun")).toContainText("3 days longer than planned");
  await expect(student.getByTestId("migration-days-left")).toHaveText("17 days");
  await expect(student.getByTestId("migration-panel").locator('[data-phase="moving"]')).toContainText("10 days");
});

test("leaving SaaS warns that add-ons will be lost, then leaves them behind", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Locked In Ltd", productType: "social", model: "saas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/product`);
  await student.getByRole("button", { name: "Buy Direct messages add-on" }).click();
  await expect(student.getByTestId("features").locator('[data-feature="messaging"]')).toHaveAttribute(
    "data-status",
    "addon",
  );

  // The confirm step for IaaS warns, by name, which add-ons stay behind and why.
  await goTo(student, "Infrastructure");
  const panel = student.getByTestId("migration-panel");
  await panel.locator("label.choice", { hasText: "Rent VMs (IaaS)" }).click();
  await student.getByRole("button", { name: "Plan migration" }).click();
  const warning = student.getByTestId("lockin-warning");
  await expect(warning).toContainText("Vendor lock-in");
  await expect(warning).toContainText("You'll lose 1 add-on");
  await expect(warning.locator('[data-addon="messaging"]')).toContainText("Direct messages");
  await expect(warning).toContainText("Add-ons belong to the SaaS provider");
  await student.getByRole("button", { name: "Start migration" }).click();
  await expect(student.getByTestId("addons-at-risk")).toContainText("Direct messages");

  // Skip to the migration's last day, with cash to pay for it, then finish it.
  const sql = postgres(E2E_DATABASE_URL);
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{migration,phase}', '"moving"'),
      '{migration,phaseDaysDone}', '6') || '{"cash": 1000000}'::jsonb where id = ${id}`;
  } finally {
    await sql.end();
  }
  await student.reload();
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(panel).toContainText("1 completed");
  await goTo(student, "Product");
  const features = student.getByTestId("features");
  await expect(features.getByRole("heading", { name: "Features" })).toBeVisible();
  await expect(student.getByTestId("addons-left-behind")).toContainText("Direct messages stayed with the SaaS provider");
  await expect(features.locator('[data-feature="messaging"]')).toHaveAttribute("data-status", "notStarted");
  await expect(student.getByRole("button", { name: "Build Direct messages" })).toBeEnabled();
});

test("a scripted event shows a card that names the layer and highlights it in the stack", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const company = async (name: string, model: string) => {
    const created = await request.post(`/api/codes/${code}/companies`, { data: { name, productType: "social", model } });
    return (await created.json()).id as string;
  };
  const [onprem, paas] = [await company("Patchy Ltd", "onprem"), await company("Platform Ltd", "paas")];

  // The default config patches the OS on day 3. On-prem needs 2 ops to patch, and a new company has 1.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${onprem}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("event-card")).toHaveCount(0);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`3 of ${E2E_FINAL_DAY}`);

  // The event card is on Home.
  const card = student.getByTestId("event-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-event", "osPatch");
  await expect(card.getByRole("strong").first()).toHaveText("OS security patch");
  await expect(card.getByTestId("event-responsibility")).toHaveText("OS and patching is your job on-prem.");
  await expect(card.getByTestId("event-outcome")).toContainText("attackers got in");
  await expect(card.getByTestId("event-tone")).toHaveText("It hurt");
  await expect(student.getByTestId("home-alerts")).toContainText("OS security patch");
  // It's in the day log too, with the outage and clean-up it caused.
  const dayLog = await openDayLog(student);
  await expect(dayLog.getByTestId("event")).toContainText("OS and patching is your job on-prem.");
  await expect(dayLog.getByTestId("outage")).toContainText("OS security patch");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("Cleaning up after the break-in");
  await student.keyboard.press("Escape");
  // The layer that decided it is highlighted in the stack, and the card links to it on the Infrastructure page.
  await card.getByRole("button", { name: "See OS and patching in the stack" }).click();
  const os = student.getByTestId("stack").locator('[data-layer="os"]');
  await expect(os).toBeFocused();
  await expect(os).toHaveAttribute("data-event", "osPatch");
  await expect(os).toContainText("OS security patch");

  // Gone the next day.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`4 of ${E2E_FINAL_DAY}`);
  await expect(os).not.toHaveAttribute("data-event", "osPatch");
  await goTo(student, "Home");
  await expect(student.getByTestId("event-card")).toHaveCount(0);

  // On PaaS the same day's patch is the provider's job: nothing to do.
  await student.goto(`/play/${code}/${paas}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(card).toBeVisible();
  await expect(card.getByTestId("event-responsibility")).toHaveText("OS and patching is the provider's job on PaaS.");
  await expect(card.getByTestId("event-tone")).toHaveText("Not your problem");
  await expect(student.getByTestId("uptime")).toHaveText("100%");
});

test("on SaaS, a feature the platform can't provide shows a card, then stays on screen", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Walled Garden Ltd", productType: "social", model: "saas" },
  });
  const { id } = await created.json();

  // The default config opens the SaaS feature gap on day 6.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  for (let day = 2; day <= 6; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }

  const card = student.getByTestId("event-card").and(student.locator('[data-event="saasFeatureGap"]'));
  await expect(card).toBeVisible();
  await expect(card.getByRole("strong").first()).toHaveText("A feature SaaS can't provide");
  await expect(card.getByTestId("event-responsibility")).toHaveText(
    "Application / features is shared between you and the provider on SaaS.",
  );
  await expect(card.getByTestId("event-outcome")).toContainText("a feed that ranks posts your way, and no add-on offers it");
  await expect(card.getByTestId("event-tone")).toHaveText("It hurt");
  await expect((await openDayLog(student)).getByTestId("event")).toContainText("A feature SaaS can't provide");
  await student.keyboard.press("Escape");
  await goTo(student, "Infrastructure");
  const application = student.getByTestId("stack").locator('[data-layer="application"]');
  await expect(application).toHaveAttribute("data-event", "saasFeatureGap");

  // The next day the card has gone, but the gap is still on screen: on Home, in the stack and in the add-on shop.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`7 of ${E2E_FINAL_DAY}`);
  await expect(application).toHaveAttribute("data-gap", "saasFeatureGap");
  await expect(application).toContainText("Feature gap");
  await goTo(student, "Home");
  await expect(card).toHaveCount(0);
  const gap = student.getByTestId("feature-gap");
  await expect(gap).toBeVisible();
  await expect(gap).toContainText("Growth is 20% slower every day until you migrate");
  await expect(student.getByTestId("home-alerts")).toContainText("Feature gap");
  await gap.getByRole("button", { name: "See Application / features in the stack" }).click();
  await expect(application).toBeFocused();
  await goTo(student, "Product");
  await expect(student.getByTestId("gap-shop-note")).toContainText("a feed that ranks posts your way");
});

test("a company plays to the final day and sees its summary, again when reopened", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Finishers Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Hire the ops IaaS needs, so the game runs smoothly to the end.
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "hire", pool: "ops" } });

  // The e2e server runs a short game. Play every day of it.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  for (let day = 2; day <= E2E_FINAL_DAY; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    if (day < E2E_FINAL_DAY) await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }

  // The end: a banner, the last day's log, and the summary in place of the controls.
  await expect(student.getByTestId("finished-screen")).toContainText(`You made it to day ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("home-day-log").getByTestId("finished")).toContainText(
    `Day ${E2E_FINAL_DAY} was the last`,
  );
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const summary = student.getByTestId("summary");
  await expect(summary).toContainText(`Played all ${E2E_FINAL_DAY} days`);
  await expect(student.getByTestId("summary-migrations")).toHaveText("0");
  await expect(student.getByTestId("summary-users")).toHaveText(/^\d{1,3}(,\d{3})*$/);
  await expect(student.getByTestId("summary-uptime")).toHaveText(/%$/);

  // The figures agree with the API's summary, and the spend split adds up.
  const api = await (await request.get(`/api/codes/${code}/companies/${id}/summary`)).json();
  expect(api).toMatchObject({ ending: "completed", day: E2E_FINAL_DAY, migrations: 0 });
  const money = (n: number) => n.toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });
  await expect(student.getByTestId("summary-cash")).toHaveText(money(api.cash));
  await expect(student.getByTestId("summary-spend-total")).toHaveText(money(api.totalSpend));
  for (const c of ["staff", "infrastructure", "addons"]) {
    await expect(student.getByTestId(`summary-spend-${c}`)).toHaveText(money(api.spend[c]));
  }
  expect(api.spend.staff + api.spend.infrastructure + api.spend.addons).toBe(api.totalSpend);

  // The cost-over-time chart: a bar for every day, with the costliest day labelled. Day 1 has the £2,000 IaaS upfront
  // cost, but a scripted event can cost more.
  const chart = student.getByTestId("cost-chart");
  await expect(chart.getByRole("img", { name: "Spend each day" })).toBeVisible();
  await expect(chart.locator("g[data-day]")).toHaveCount(E2E_FINAL_DAY);
  type Day = { day: number; staff: number; infrastructure: number; addons: number };
  const spent = (d: Day) => d.staff + d.infrastructure + d.addons;
  expect(spent(api.days[0])).toBeGreaterThanOrEqual(2000);
  const peak = (api.days as Day[]).reduce((a, b) => (spent(b) > spent(a) ? b : a));
  await expect(student.getByTestId("cost-peak")).toHaveText(`Day ${peak.day}: ${money(spent(peak))}`);
  await expect(chart.getByRole("list", { name: "Key" })).toContainText("Infrastructure");
  await expect(student.getByTestId("cash-chart")).toBeVisible();

  // The API refuses to carry on.
  const again = await request.post(`/api/codes/${code}/companies/${id}/continue`);
  expect(again.status()).toBe(409);
  expect((await again.json()).error).toBe("finished");

  // Reopened from the company list, it goes straight to the summary.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  // A finished game is history, not one of the active companies.
  const row = elsewhere.getByTestId("history").getByRole("link", { name: /Finishers Ltd/ });
  await expect(row).toContainText("Finished");
  await row.click();
  await expect(elsewhere.getByTestId("finished-screen")).toBeVisible();
  await expect(elsewhere.getByTestId("summary")).toContainText(`Played all ${E2E_FINAL_DAY} days`);
  await expect(elsewhere.getByTestId("summary-cash")).toHaveText(money(api.cash));
  await expect(elsewhere.getByRole("button", { name: "Continue" })).toBeDisabled();
  // Its pages are a read-only record.
  await goTo(elsewhere, "Product");
  await expect(elsewhere.getByTestId("read-only")).toBeVisible();
  await expect(elsewhere.getByRole("button", { name: "Build Groups" })).toBeDisabled();
});

test("a code runs up to 3 active companies; retiring one moves it to history and makes room", async ({ browser }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  async function startCompany(name: string) {
    await student.getByLabel("Company name").fill(name);
    await student.locator("label.choice", { hasText: "E-commerce platform" }).click();
    await student.locator("label.choice", { hasText: "(PaaS)" }).click();
    await student.getByRole("button", { name: "Start company" }).click();
    await expect(student.getByRole("heading", { name })).toBeVisible();
    await student.getByRole("link", { name: "Your companies" }).click();
  }

  // Names don't need to be unique: two companies share one here.
  for (const name of ["Alpha Ltd", "Alpha Ltd", "Gamma Ltd"]) await startCompany(name);
  const active = student.getByTestId("active-companies");
  await expect(active.getByRole("listitem")).toHaveCount(3);
  await expect(active).toContainText("3 of 3");

  // At the limit, the form is replaced by a message saying to retire one first.
  await expect(student.getByTestId("limit-message")).toContainText("retire one of them first");
  await expect(student.getByRole("button", { name: "Start company" })).toHaveCount(0);

  // Retiring asks first, and Cancel leaves it alone.
  await student.getByRole("button", { name: "Retire Gamma Ltd" }).click();
  await student.getByRole("button", { name: "Cancel" }).click();
  await expect(active.getByRole("listitem")).toHaveCount(3);
  await student.getByRole("button", { name: "Retire Gamma Ltd" }).click();
  await expect(student.getByRole("group", { name: "Retire Gamma Ltd?" })).toContainText("moves to your history");
  await student.getByRole("button", { name: "Yes, retire it" }).click();

  await expect(active.getByRole("listitem")).toHaveCount(2);
  const history = student.getByTestId("history");
  await expect(history.getByRole("link", { name: /Gamma Ltd/ })).toContainText("Retired");
  await expect(student.getByTestId("limit-message")).toHaveCount(0);

  // The freed slot takes a new company.
  await startCompany("Delta Ltd");
  await expect(active.getByRole("listitem")).toHaveCount(3);
  await expect(student.getByTestId("limit-message")).toBeVisible();

  // The retired game opens read-only, with its summary.
  await history.getByRole("link", { name: /Gamma Ltd/ }).click();
  await expect(student.getByTestId("retired-screen")).toContainText("You retired Gamma Ltd");
  await expect(student.getByTestId("summary")).toContainText("Retired on day 1");
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
});

test("the teacher archives a game, finds it under Archived, then deletes it", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Archive Me Ltd", productType: "ecommerce", model: "paas" },
  });
  const { id } = await created.json();
  await teacher.reload();
  const live = teacher.getByTestId("live-dashboard");
  await expect(live.getByRole("link", { name: "Archive Me Ltd" })).toBeVisible();

  // Archiving takes it off the live list.
  await live.getByRole("button", { name: "Archive Archive Me Ltd" }).click();
  await expect(live.getByRole("link", { name: "Archive Me Ltd" })).toHaveCount(0);

  // Archiving is only the teacher's view: the student can keep playing.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);

  // It's under Archived.
  await live.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(live.getByRole("heading", { name: "Archived games" })).toBeVisible();
  await expect(live.getByRole("link", { name: "Archive Me Ltd" })).toBeVisible();

  // Deleting asks first, naming the company, and Cancel leaves it alone.
  await live.getByRole("button", { name: "Delete Archive Me Ltd" }).click();
  const confirm = live.getByRole("group", { name: "Delete Archive Me Ltd?" });
  await expect(confirm).toContainText("can't be undone");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(live.getByRole("link", { name: "Archive Me Ltd" })).toBeVisible();

  await live.getByRole("button", { name: "Delete Archive Me Ltd" }).click();
  await confirm.getByRole("button", { name: "Yes, delete it" }).click();
  await expect(live.getByRole("link", { name: "Archive Me Ltd" })).toHaveCount(0);
  expect((await request.get(`/api/codes/${code}/companies/${id}`)).status()).toBe(404);
});

test("a Home card opens an accessible modal with its controls, and Continue works from any page", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Modal Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("home-staff")).toContainText("2 dev · 1 ops");

  // The Staff card opens a labelled modal dialog, with focus on its first control.
  const card = student.getByRole("button", { name: "Staff" });
  await card.click();
  const modal = student.getByRole("dialog", { name: "Staff" });
  await expect(modal).toBeVisible();
  await expect(modal).toHaveAttribute("aria-modal", "true");
  await expect(modal.getByRole("button", { name: "Let go one developer" })).toBeFocused();

  // Its quick actions work in place, and the card behind it keeps up.
  await modal.getByRole("button", { name: "Hire one ops person" }).click();
  await expect(modal.getByTestId("ops-count")).toHaveText("2");
  await expect(student.getByTestId("home-staff")).toContainText("2 dev · 2 ops");

  // Focus is trapped: Tab from the last control goes round to the first, and Shift+Tab back again.
  const close = modal.getByRole("button", { name: "Close" });
  const last = modal.getByRole("link", { name: "Open People" });
  await last.focus();
  await student.keyboard.press("Tab");
  await expect(close).toBeFocused();
  await student.keyboard.press("Shift+Tab");
  await expect(last).toBeFocused();

  // Escape closes it and focus goes back to the card that opened it.
  await student.keyboard.press("Escape");
  await expect(modal).toHaveCount(0);
  await expect(card).toBeFocused();

  // The close button works too.
  await student.getByRole("button", { name: "Cash" }).click();
  await student.getByRole("dialog", { name: "Cash" }).getByRole("button", { name: "Close" }).click();
  await expect(student.getByRole("dialog")).toHaveCount(0);
  await expect(student.getByRole("button", { name: "Cash" })).toBeFocused();

  // Continue, in the nav bar, plays a day from a page other than Home, and the student stays on that page.
  await goTo(student, "Finance");
  await expect(student).toHaveURL(new RegExp(`/play/${code}/${id}/finance$`));
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student).toHaveURL(new RegExp(`/play/${code}/${id}/finance$`));
  await expect(student.getByTestId("spend-staff")).toHaveText("£600");
});

test("a student sets a price, plays a day and sees the income on Finance", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  await teacher.getByRole("button", { name: "Create code" }).click();
  const code = await teacher.locator("td[data-code]").first().getAttribute("data-code");

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Pricey Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  // A social network starts with 1,000 users, 80% of them free, at its fair price of £6 a month: 200 × £6 ÷ 30.
  await expect(student.getByTestId("home-income")).toContainText("£40");
  await expect(student.getByTestId("home-paid-free")).toContainText("200 paying, 800 free");

  await goTo(student, "Customers");
  await expect(student.getByTestId("paid-users")).toHaveText("200");
  await expect(student.getByTestId("free-users")).toHaveText("800");

  // The price is set in a modal on Product, with the fair price as a hint.
  await goTo(student, "Product");
  await expect(student.getByTestId("price")).toHaveText("£6");
  await student.getByRole("button", { name: "Change price" }).click();
  const dialog = student.getByRole("dialog", { name: "Set your price" });
  await expect(dialog.getByTestId("fair-price-hint")).toContainText("£6");
  const input = dialog.getByLabel("Monthly price per paying user (£)");
  // Out of range is turned away before it's sent.
  await input.fill("0");
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog.getByRole("alert")).toContainText("above £0");
  await input.fill("30");
  await expect(dialog).toContainText("£200 a day");
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog).toBeHidden();
  await expect(student.getByTestId("price")).toHaveText("£30");
  await expect(student.getByTestId("daily-income")).toHaveText("£200");

  // It applies from the next day: 200 paying users at £30 a month bring in £200.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await goTo(student, "Finance");
  const sheet = student.getByTestId("balance-sheet");
  await expect(sheet).toContainText("Day 2");
  await expect(student.getByTestId("balance-day-income")).toHaveText("£200");
  await expect(student.getByTestId("balance-income")).toHaveText("£200");
  // £200 in, against IaaS's £2,000 upfront and £200 a day, and 2 developers and 1 ops person.
  await expect(student.getByTestId("balance-profit")).toHaveText("−£2,460");
  await expect(student.getByTestId("balance-day-profit")).toHaveText("−£460");
  await expect(student.getByTestId("cash-chart")).toBeVisible();
  await expect((await openDayLog(student)).getByTestId("log-income")).toHaveText("+£200");
});
