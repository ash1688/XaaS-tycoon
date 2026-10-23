import { expect, test, type Page } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode, launch, pinLaunchUsers, withOnlyEncounter } from "./staff.ts";

// The game's pages are reached through its nav bar.
const goTo = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Game" }).getByRole("link", { name, exact: true }).click();

/**
 * Pins a launched company's paying users to the product's split of its launch users, as if no free user had started
 * paying on the way in, so a test's sums come out round.
 */
async function pinPaidUsers(id: string, paidUsers: number) {
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{paidUsers}', ${String(paidUsers)}::jsonb) where id = ${id}`;
  } finally {
    await sql.end();
  }
}

// The full day log opens as a modal from its card on Home. Returns the latest day in it.
async function openDayLog(page: Page) {
  await goTo(page, "Home");
  await page.getByRole("button", { name: "Day log" }).click();
  return page.getByRole("dialog", { name: "Day log" }).getByTestId("day-log");
}

test("teacher creates a code, student starts a game and presses Continue", async ({ browser, request }) => {
  // Teacher
  const teacher = await (await browser.newContext()).newPage();
  // A controllable clock, so the live dashboard's refresh can be run on without waiting for it.
  await teacher.clock.install();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  expect(code).toMatch(/^\d{8}$/);

  // Student, in a separate browser context (no teacher cookie)
  const student = await (await browser.newContext()).newPage();
  await student.goto("/");
  await student.getByLabel("Login code").fill("00000000");
  await student.getByRole("button", { name: "Go" }).click();
  await expect(student.getByRole("alert")).toContainText("wasn't recognised");

  await student.getByLabel("Login code").fill(code!);
  await student.getByRole("button", { name: "Go" }).click();
  await expect(student.getByRole("table").first()).toContainText("Ops staff needed");
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
  // Home's overview cards. £15,000 starting cash less IaaS's £2,000 upfront cost, and no users or servers until launch.
  await expect(student.getByTestId("cash")).toHaveText("£13,000");
  await expect(student.getByTestId("users")).toHaveText("0");
  await expect(student.getByTestId("launch-headline")).toHaveText("Waiting for capacity");

  // Infrastructure: CU, DBU and CH against capacity, the servers and the responsibility stack, on its own page.
  await goTo(student, "Infrastructure");
  await expect(student).toHaveURL(`${game}/infrastructure`);
  await expect(student.getByRole("link", { name: "Infrastructure", exact: true })).toHaveAttribute("aria-current", "page");
  // The teaching line stays in the shell on every page.
  await expect(student.getByText("You're the customer of the layer below.")).toBeVisible();
  const stack = student.getByTestId("stack");
  await expect(stack.locator('[data-layer="os"]')).toContainText("OS and patching");
  await expect(stack.locator('[data-layer="os"]')).toContainText("You");
  await expect(stack.locator('[data-layer="hardware"]')).toContainText("Provider");
  await expect(student.getByRole("meter", { name: /^Compute \(CU\)/ })).toBeVisible();
  // The first setup: a medium app server and database, 10 CU and 10 DBU, ready the next day. One app server needs no
  // load balancer.
  const panel = student.getByTestId("servers-panel");
  for (const type of ["app", "database"]) {
    await panel.getByTestId(`size-${type}`).selectOption("medium");
    await panel.getByTestId(`step-${type}-up`).click();
    await expect(panel.getByTestId(`step-${type}-value`)).toHaveText("1 medium");
  }
  await expect(student.getByTestId("servers-panel").getByTestId("pending-app-medium")).toContainText("1 setting up");
  await expect(student.getByTestId("lb-status")).toContainText("no load balancer needed");

  await goTo(student, "Finance");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,000");
  // £700 a month and £300 of power and cooling, plus £450 and £540 for the VMs.
  await expect(student.getByTestId("model-costs")).toContainText("£1,990 a month");

  // Staff: the VMs need 1 ops, and a new company starts with 1.
  await goTo(student, "People");
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 1 ops staff");
  await expect(student.getByTestId("ops-needed")).not.toContainText("Understaffed");
  // A mid hired now starts in 7 days: shown waiting, not on the team or paid until then.
  await student.getByRole("button", { name: "Hire one mid developer" }).click();
  await expect(student.getByTestId("developers-hiring")).toHaveText("1 mid hired: starts on day 8, in 7 days.");
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("support-count")).toHaveText("1");
  await expect(student.getByTestId("staff-cost")).toHaveText("£460");
  // The grades: a junior would start in 3 days, a senior in 14.
  await student.getByRole("radio", { name: "Junior" }).first().check();
  await expect(student.getByTestId("developers-grade-note")).toContainText("Juniors: £90 each a day, 0.65× a mid's work, start 3 days after hiring.");

  // Features: IaaS builds them in developer-days, one at a time.
  await goTo(student, "Product");
  const features = student.getByTestId("features");
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "notStarted");
  await student.getByRole("button", { name: "Build Photo sharing" }).click();
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "building");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("0 of 16 developer-days");
  await expect(student.getByRole("button", { name: "Build Groups" })).toBeDisabled();

  // Timed flow is on by default, and a game opens paused, so Continue still plays a day at a time.
  await expect(student.getByTestId("timed-status")).toContainText("Paused");
  // Continue is in the nav bar, so it plays the day from any page, here Product.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(student).toHaveURL(`${game}/product`);
  // 2 developers did 2 developer-days on the build; 14 left at 2 a day is 7 days.
  await expect(student.getByTestId("feature-progress-photos")).toContainText("2 of 16 developer-days");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("7 days left with 2 developers");
  await expect(student.getByRole("progressbar", { name: "Photo sharing" })).toHaveAttribute("aria-valuenow", "2");

  // Spend so far, split by category.
  await goTo(student, "Finance");
  await expect(student.getByTestId("spend-staff")).toHaveText("£460");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,056");
  await expect(student.getByTestId("spend-power")).toHaveText("£10");
  await expect(student.getByTestId("spend-addons")).toHaveText("£0");
  await expect(student.getByTestId("spend-total")).toHaveText("£2,526");
  await expect(student.getByTestId("cash-chart")).toBeVisible();

  await goTo(student, "Home");
  // £66 of IaaS (£23 running costs, £10 power and cooling, and £15 and £18 of VM rent) + 2 developers × £120 + 1 ops × £120
  // + 1 support × £100 out, and nothing in: the first users arrive at the end of day 2, a fifth of the game's launch
  // users. Home shows the users the API has.
  await expect(student.getByTestId("cash")).toHaveText("£12,474");
  const [, , code2, id2] = game.split("/");
  const { users: joined } = await (await request.get(`/api/codes/${code2}/companies/${id2}`)).json();
  expect(joined).toBeGreaterThanOrEqual(500);
  await expect(student.getByTestId("users")).toHaveText(joined.toLocaleString("en-GB"));
  await expect(student.getByTestId("launch-headline")).toHaveText("Launching: users arriving (day 1 of 3)");
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  // The day log card has each category's total; its modal has every line.
  await expect(student.getByTestId("home-day-log").locator('[data-category="staff"]')).toContainText("£460");
  const dayLog = await openDayLog(student);
  await expect(dayLog.locator('[data-category="staff"]')).toContainText("Developers pay (2 mids)");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("running costs");
  await expect(dayLog).toContainText("Building Photo sharing: 2 of 16 developer-days done.");
  await student.keyboard.press("Escape");
  await expect(dayLog).toHaveCount(0);

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText(`2 of ${E2E_FINAL_DAY}`);
  await expect(elsewhere.getByTestId("users")).toHaveText(joined.toLocaleString("en-GB"));
  await goTo(elsewhere, "People");
  await expect(elsewhere.getByTestId("developers-count")).toHaveText("2");
  await expect(elsewhere.getByTestId("developers-hiring")).toHaveText("1 mid hired: starts on day 8, in 6 days.");
  // A page opens straight from its address, as a bookmark would.
  await elsewhere.goto(`${game}/product`);
  await expect(elsewhere.getByTestId("feature-progress-photos")).toContainText("2 of 16 developer-days");

  // The teacher's live dashboard picks the game up on its next refresh, without a reload, under its code.
  const live = teacher.getByTestId("live-dashboard");
  await expect(live).toContainText("No games in this window yet.");
  await teacher.clock.runFor(20_000);
  const row = live.locator(`[data-code="${code}"] tr`, { hasText: "Playwright Ltd" });
  await expect(row.getByTestId("live-day")).toHaveText(`2/${E2E_FINAL_DAY}`);
  await expect(row).toContainText("IaaS");
  await expect(row).toContainText("£12,474");
  await expect(row).toContainText("Active");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");

  // The teacher opens the company's summary from the dashboard.
  await teacher.getByRole("link", { name: "Playwright Ltd" }).click();
  await expect(teacher.getByRole("heading", { name: "How Playwright Ltd did" })).toBeVisible();
  await expect(teacher.getByTestId("summary")).toContainText(`So far: day 2 of ${E2E_FINAL_DAY}`);
  await expect(teacher.getByTestId("summary-cash")).toHaveText("£12,474");
  await teacher.getByRole("link", { name: "← Staff dashboard" }).click();
  await expect(teacher.getByTestId("live-dashboard")).toBeVisible();
});

test("running out of cash brings a vulture VC's rescue, a buy-back, then liquidation", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Broke Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();

  // Sets the company's cash in the test database, as if it had overspent for months (or done very well).
  const setCash = async (cash: number) => {
    const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
    try {
      await sql`update companies set state = jsonb_set(state, '{cash}', to_jsonb(${cash}::int)) where id = ${id}`;
    } finally {
      await sql.end();
    }
  };
  await setCash(100);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("cash")).toHaveText("£100");
  // With days of cash left, every page warns, and Home shows the runway.
  await expect(student.getByTestId("low-cash")).toContainText("Cash runs out");
  await expect(student.getByTestId("low-cash")).toContainText("bank loan");
  await expect(student.getByTestId("home-runway")).toContainText("Runway");
  await expect(student.getByTestId("home-alerts")).toContainText("Cash runs out");
  await goTo(student, "People");
  await expect(student.getByTestId("low-cash")).toBeVisible();
  await goTo(student, "Home");
  await student.getByRole("button", { name: "Continue" }).click();

  // The first time, a vulture VC rescues the company: the cash, the share it took and the cuts.
  const rescue = student.getByTestId("home-day-log").getByTestId("rescue");
  await expect(rescue.first()).toContainText("a vulture VC rescued Broke Ltd");
  await expect(rescue.first()).toContainText("75% of the company. You now own 25%");
  await expect(rescue.nth(1)).toContainText("Forced cost cuts");
  // It's a pause trigger, so timed flow stops for it and says why.
  await expect(student.getByTestId("pause-reasons")).toContainText("Cash ran out: a vulture VC rescued the company for 75% of it");
  await expect(student.getByTestId("home-alerts")).toContainText("A vulture VC owns 75% of the company");
  await expect(student.getByRole("button", { name: "Continue" })).toBeEnabled();
  await goTo(student, "Finance");
  const panel = student.getByTestId("rescue-panel");
  await expect(panel.getByTestId("rescue-terms")).toContainText("30,000 new shares, 75% of the company");
  await expect(panel.getByTestId("rescue-cuts")).toContainText("Forced cost cuts");
  await expect(panel.getByTestId("rescue-buy-back")).toContainText("will sell all of it back for");
  await expect(panel.getByTestId("buy-back")).toBeDisabled();
  await expect(student.getByTestId("cap-table")).toContainText("Vulture VC");

  // With the cash, the student buys its shares back at its price.
  await setCash(1_000_000);
  await student.reload();
  await panel.getByTestId("buy-back").click();
  await expect(panel.getByTestId("rescue-bought-back")).toContainText("You bought its shares back on day 2");
  await expect(student.getByTestId("cap-table")).not.toContainText("Vulture VC");

  // The second time is liquidation: the game ends.
  await setCash(100);
  await student.reload();
  await goTo(student, "Home");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("liquidation-screen")).toContainText("Game over");
  await expect(student.getByTestId("liquidation-screen")).toContainText("gone into liquidation");
  await expect(student.getByTestId("low-cash")).toBeHidden();
  await expect(student.getByTestId("home-loan")).toHaveText("No bank loan: banks don't lend to a company in liquidation.");
  await expect(student.getByTestId("home-day-log").getByTestId("liquidation")).toContainText(
    "after the rescue buyout on day 2: Broke Ltd goes into liquidation",
  );
  // The game is over: Home shows the summary, Continue is off, and the pages are read-only.
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const summary = student.getByTestId("summary");
  await expect(summary).toContainText("Went into liquidation on day 3");
  await expect(student.getByTestId("summary-rescue")).toContainText("Rescued by a vulture VC on day 2");
  await expect(student.getByTestId("summary-cash")).toHaveText(/^-£/);
  await goTo(student, "People");
  await expect(student.getByTestId("read-only")).toContainText("This game has ended");
  await expect(student.getByRole("button", { name: "Hire one mid developer" })).toBeDisabled();
  await goTo(student, "Finance");
  await expect(student.getByTestId("loan-liquidated")).toContainText("banks don't lend");
  await expect(student.getByTestId("loan-open")).toBeHidden();
  await goTo(student, "Home");

  // Still liquidated after a reload, with its summary, and the API refuses to carry on.
  await student.reload();
  await expect(student.getByTestId("liquidation-screen")).toBeVisible();
  await expect(summary).toBeVisible();
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  const again = await request.post(`/api/codes/${code}/companies/${id}/continue`);
  expect(again.status()).toBe(409);

  // The staff dashboard says liquidated too.
  await teacher.goto("/staff");
  await expect(teacher.locator(`tr[data-company="${id}"]`).getByTestId("live-status")).toHaveText("Liquidated");
});

test("a SaaS company buys an add-on and pays for it per user", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Shopfront Ltd", productType: "social", model: "saas" },
  });
  const { id } = await created.json();
  // SaaS needs nothing set up: the social network's 4,000 users arrive over days 1 to 3.
  await launch(request, code, id, "saas");

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
  await student.getByRole("button", { name: "Let go one mid developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("1");
  await goTo(student, "Product");
  await expect(student.getByTestId("config-team")).toContainText("Hire 1 more to buy add-ons");
  await expect(student.getByRole("button", { name: "Buy Direct messages add-on" })).toBeDisabled();
  // A new developer would take days to start; moving the ops person in is at once.
  await goTo(student, "People");
  await student.getByRole("button", { name: "Move one ops person to developers" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("2");

  // Bought add-ons are active at once. 4,000 users at £0.08 is £320 a month.
  await goTo(student, "Product");
  await student.getByRole("button", { name: "Buy Direct messages add-on" }).click();
  await expect(shop.locator('[data-feature="messaging"]')).toHaveAttribute("data-status", "addon");
  await expect(shop.locator('[data-feature="messaging"]')).toContainText("Active");
  await expect(student.getByTestId("addon-bill")).toContainText("£320 a month");
  await goTo(student, "Finance");
  await expect(student.getByTestId("model-costs")).toContainText("£320 a month for add-ons");

  // The add-on's one-off setup fee (Direct messages is 20 developer-days at £100 each, £2,000), plus a day's share of
  // the add-on bill: £320 ÷ 30, rounded to £11, all tagged add-ons.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`4 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("spend-addons")).toHaveText("£2,011");
  await expect((await openDayLog(student)).locator('[data-category="addons"]')).toContainText(
    "Add-on: Direct messages (4,000 users at £0.08 a month)",
  );
});

test("a company migrates from IaaS to PaaS in the background while staff keep working", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Movers Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Its first VMs rented on day 1: all its launch users are in by day 4.
  await launch(request, code, id, "iaas");

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
  await expect(quote).toContainText("You switch on day 18");
  await expect(student.getByTestId("quote-days")).toHaveText("14 days");
  // Default config: PaaS is £1,000 upfront and £109 a day (power and cooling included) with one instance and a small
  // managed database, sized for the users; IaaS £66 a day with its VMs, and £3,000 to leave.
  await expect(student.getByTestId("quote-upfront")).toHaveText("£1,000");
  await expect(student.getByTestId("quote-double")).toHaveText("£1,526");
  await expect(student.getByTestId("quote-pro-rata")).toHaveText("£924");
  await expect(student.getByTestId("quote-exit")).toHaveText("£3,000");
  await expect(student.getByTestId("quote-total")).toHaveText("£6,450");
  await expect(student.getByTestId("quote-overrun")).toContainText("chance of 2–5 extra days");
  // Nothing has started or been charged yet.
  const company = async () => (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  // IaaS's £2,000 up front and three days of its £66: £56 of infrastructure and £10 of power and cooling.
  expect(await company()).toMatchObject({ migration: null, spend: { infrastructure: 2168, power: 30 } });
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
  for (let day = 5; day <= 9; day++) await continueTo(day);
  // Still on IaaS, and billed for it, until the move completes; PaaS is billed in full on top.
  await expect(student.getByTestId("ops-needed")).toContainText("needs 1 ops staff");
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

  // Moving starts on day 11. Seeds are random here, so it may overrun: if so, the panel shows the extra days.
  await goTo(student, "Infrastructure");
  for (let day = 10; day <= 11; day++) await continueTo(day);
  const daysLeft = Number((await student.getByTestId("migration-days-left").textContent())!.split(" ")[0]);
  if (daysLeft > 7) await expect(student.getByTestId("migration-overrun")).toContainText(`${daysLeft - 7} days`);
  else await expect(student.getByTestId("migration-overrun")).toHaveCount(0);
  for (let day = 12; day <= 11 + daysLeft; day++) await continueTo(day);
  await expect(panel).toContainText("1 completed");
  await expect(stack.locator('[data-layer="os"]')).toContainText("Provider");
  await expect(stack.locator('[data-layer="os"]')).toContainText("was You");
  await goTo(student, "People");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 1 ops staff");
  await goTo(student, "Finance");
  await expect(student.getByTestId("model-costs")).toContainText("£1,300 a month plus your instances and managed services");
  dayLog = await openDayLog(student);
  await expect(dayLog).toContainText("Migration complete");
  await expect(dayLog).toContainText("Exit penalty: leaving Rent VMs (IaaS)");
});

test("a migration that overruns shows the extra days", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

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
  const code = await createCode(teacher);

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

test("a random event shows a card that names the layer and highlights it in the stack", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // Each sets up its first servers on day 1, so it launches on day 3. Its launch total is pinned to round two's 4,000:
  // a drawn one can be big enough to overload the medium servers on day 4, and the overload outage would mask the
  // patch's.
  const company = async (name: string, model: string, actions: object[]) => {
    const created = await request.post(`/api/codes/${code}/companies`, { data: { name, productType: "social", model } });
    const id = (await created.json()).id as string;
    await pinLaunchUsers(id, 4_000);
    for (const data of actions) expect((await request.post(`/api/codes/${code}/companies/${id}/actions`, { data })).ok()).toBe(true);
    return id;
  };
  // Games started with only the OS patch as a random event, at a threshold of 2 on the danger meter. Each launches on
  // day 2, so the meter reaches 2 by the end of day 3 and the patch comes on day 4.
  const [iaas, paas] = await withOnlyEncounter(request, "osPatch", 2, async () => [
    // An IaaS company that lets its one ops person go: nobody is left to patch.
    await company("Patchy Ltd", "iaas", [
      { type: "rentServer", server: "app", size: "medium" },
      { type: "rentServer", server: "database", size: "medium" },
      { type: "letGo", pool: "ops" },
    ]),
    await company("Platform Ltd", "paas", [
      { type: "setInstances", count: 1 },
      { type: "setManagedService", service: "database", size: "small" },
    ]),
  ]);

  // IaaS needs 1 ops to patch, and this company has none. Home shows the danger meter climbing before it fires.
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${iaas}`);
  for (let day = 2; day <= 3; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
    await expect(student.getByTestId("event-card")).toHaveCount(0);
  }
  await expect(student.getByTestId("danger-rise")).toContainText("+1.5");
  await expect(student.getByTestId("danger-text")).toContainText("Climbing fast: servers going unpatched");
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`4 of ${E2E_FINAL_DAY}`);

  // The event card is on Home.
  const card = student.getByTestId("event-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-event", "osPatch");
  await expect(card.getByRole("strong").first()).toHaveText("OS security patch");
  await expect(card.getByTestId("event-responsibility")).toHaveText("OS and patching is your job on IaaS.");
  await expect(card.getByTestId("event-outcome")).toContainText("attackers got in");
  await expect(card.getByTestId("event-tone")).toHaveText("It hurt");
  await expect(student.getByTestId("home-alerts")).toContainText("OS security patch");
  // It's in the day log too, with the outage and clean-up it caused.
  const dayLog = await openDayLog(student);
  await expect(dayLog.getByTestId("event")).toContainText("OS and patching is your job on IaaS.");
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
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await expect(os).not.toHaveAttribute("data-event", "osPatch");
  await goTo(student, "Home");
  await expect(student.getByTestId("event-card")).toHaveCount(0);

  // On PaaS the same day's patch is the provider's job: nothing to do.
  await student.goto(`/play/${code}/${paas}`);
  for (let day = 2; day <= 4; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
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
  const code = await createCode(teacher);

  // Started with only the feature gap as a random event, at a threshold of 4. SaaS launches as the game starts, so the
  // danger meter reaches 4 at the end of day 5 and the gap opens on day 6.
  const created = await withOnlyEncounter(request, "saasFeatureGap", 4, () =>
    request.post(`/api/codes/${code}/companies`, { data: { name: "Walled Garden Ltd", productType: "social", model: "saas" } }),
  );
  const { id } = await created.json();

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

test("viral growth brings a wave of free users, shown as good news with whose job it is to carry them", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // Started with only viral growth as a random event, at a threshold of 4. SaaS launches as the game starts, so the
  // danger meter reaches 4 at the end of day 5 and the wave comes on day 6.
  const created = await withOnlyEncounter(request, "viralGrowth", 4, () =>
    request.post(`/api/codes/${code}/companies`, { data: { name: "Buzz Ltd", productType: "social", model: "saas" } }),
  );
  const { id } = await created.json();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  for (let day = 2; day <= 6; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }

  const card = student.getByTestId("event-card");
  await expect(card).toHaveAttribute("data-event", "viralGrowth");
  await expect(card.getByRole("strong").first()).toHaveText("Viral growth");
  await expect(card.getByTestId("event-responsibility")).toHaveText("Runtime and scaling is the provider's job on SaaS.");
  await expect(card.getByTestId("event-outcome")).toContainText(/[\d,]+ new free users signed up\. They're staying\./);
  await expect(card.getByTestId("event-tone")).toHaveText("Good news");
  const dayLog = await openDayLog(student);
  await expect(dayLog.getByTestId("event")).toContainText("new free users signed up");
});

test("a company plays to the final day and sees its summary, again when reopened", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Finishers Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Plenty of cash in the test database, so it lasts the game whatever its costs: this test is about the ending, not
  // the balance.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{cash}', '100000') where id = ${id}`;
  } finally {
    await sql.end();
  }
  // Move a developer into ops, at once, for the ops IaaS needs, so the game runs smoothly to the end.
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "moveStaff", to: "ops" } });

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
  const categories = ["staff", "infrastructure", "cabling", "power", "addons"] as const;
  for (const c of categories) {
    await expect(student.getByTestId(`summary-spend-${c}`)).toHaveText(money(api.spend[c]));
  }
  expect(categories.reduce((sum, c) => sum + api.spend[c], 0)).toBe(api.totalSpend);

  // The cost-over-time chart: a bar for every day, with the costliest day labelled. Day 1 has the £2,000 IaaS upfront
  // cost, but a scripted event can cost more.
  const chart = student.getByTestId("cost-chart");
  await expect(chart.getByRole("img", { name: "Spend each day" })).toBeVisible();
  await expect(chart.locator("g[data-day]")).toHaveCount(E2E_FINAL_DAY);
  type Day = { day: number } & Record<(typeof categories)[number], number>;
  const spent = (d: Day) => categories.reduce((sum, c) => sum + d[c], 0);
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
  const code = await createCode(teacher);

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
  const code = await createCode(teacher);

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
  const code = await createCode(teacher);

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
  await expect(modal.getByRole("radio", { name: "Junior" }).first()).toBeFocused();

  // Its quick actions work in place. A hire waits for its grade's lead time; a move is at once, and the card behind
  // it keeps up.
  await modal.getByRole("button", { name: "Hire one mid ops person" }).click();
  await expect(modal.getByTestId("ops-hiring")).toHaveText("1 mid hired: starts on day 8, in 7 days.");
  await expect(modal.getByTestId("ops-count")).toHaveText("1");
  await modal.getByRole("button", { name: "Move one developer to ops staff" }).click();
  await expect(modal.getByTestId("ops-count")).toHaveText("2");
  await expect(student.getByTestId("home-staff")).toContainText("1 dev · 2 ops");
  // Many at once: the number box hires that many of the picked grade in one go.
  await modal.getByRole("radio", { name: "Junior" }).nth(2).check();
  await modal.getByTestId("support-amount").fill("25");
  await expect(modal.getByTestId("support-bulk")).toContainText("£1,875 a day for 25 junior support staff");
  await modal.getByTestId("support-hire-many").click();
  await expect(modal.getByTestId("support-hiring")).toHaveText("25 junior hired: start on day 4, in 3 days.");
  await expect(modal.getByTestId("support-count")).toHaveText("1");
  // Letting go is of those on the team, by grade: no juniors have started yet.
  await expect(modal.getByTestId("support-let-go-many")).toBeDisabled();

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
  // 1 developer, 2 ops and 1 support: the hires waiting aren't paid yet.
  await expect(student.getByTestId("spend-staff")).toHaveText("£460");
});

test("a student sets a price, plays a day and sees the income on Finance", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Pricey Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Its first VMs rented on day 1: all its launch users are in by day 4.
  await launch(request, code, id, "iaas");
  await pinPaidUsers(id, 1_200);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  // A social network launches with 4,000 users, 70% of them free, at its fair price of £5 a month: 1,200 × £5 ÷ 30.
  await expect(student.getByTestId("home-income")).toContainText("£200");
  await expect(student.getByTestId("home-paid-free")).toContainText("1,200 paying, 2,800 free");

  await goTo(student, "Customers");
  await expect(student.getByTestId("paid-users")).toHaveText("1,200");
  await expect(student.getByTestId("free-users")).toHaveText("2,800");

  // The price is set in a modal on Product, with the fair price as a hint.
  await goTo(student, "Product");
  await expect(student.getByTestId("price")).toHaveText("£5");
  await student.getByRole("button", { name: "Change price" }).click();
  const dialog = student.getByRole("dialog", { name: "Set your price" });
  await expect(dialog.getByTestId("fair-price-hint")).toContainText("£5");
  const input = dialog.getByLabel("Monthly price per paying user (£)");
  // Out of range is turned away before it's sent.
  await input.fill("0");
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog.getByRole("alert")).toContainText("above £0");
  await input.fill("30");
  // Six times the fair price: the live preview shows almost every payer going (only some professionals and businesses
  // put up with it), so income ends up far lower.
  await expect(dialog.getByTestId("preview-income")).toHaveText("£23");
  // A gentler rise instead: £6, a fifth above fair. 1,200 paying users at £6 a month would bring in £240 a day.
  await input.fill("6");
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog).toBeHidden();
  await expect(student.getByTestId("price")).toHaveText("£6");
  await expect(student.getByTestId("daily-income")).toHaveText("£240");

  // It applies from the next day. A few payers refuse the new price at once, so the day's income is whatever the ones
  // who stayed paid: read it from the company's running income.
  const before = (await (await request.get(`/api/codes/${code}/companies/${id}`)).json()).income;
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await goTo(student, "Finance");
  const sheet = student.getByTestId("balance-sheet");
  await expect(sheet).toContainText("Day 5");
  const { income, spend } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  const dayIncome = Math.round(income - before);
  const pounds = (n: number) => `${n < 0 ? "−" : ""}£${Math.abs(n).toLocaleString("en-GB")}`;
  await expect(student.getByTestId("balance-day-income")).toHaveText(pounds(dayIncome));
  // Against it, IaaS's £66 a day and 2 developers, 1 ops person and 1 support person (£460 a day). Over the game so
  // far, the income from the days users were arriving too, against IaaS's £2,000 up front and 4 days' costs.
  await expect(student.getByTestId("balance-day-profit")).toHaveText(pounds(dayIncome - 526));
  const profit = income - (spend.staff + spend.infrastructure + spend.power + spend.addons);
  expect(spend.staff + spend.infrastructure + spend.power).toBe(2_000 + 4 * 526);
  await expect(student.getByTestId("balance-income")).toHaveText(`£${income.toLocaleString("en-GB")}`);
  await expect(student.getByTestId("balance-profit")).toHaveText(`−£${(-profit).toLocaleString("en-GB")}`);
  await expect(student.getByTestId("cash-chart")).toBeVisible();
  await expect((await openDayLog(student)).getByTestId("log-income")).toHaveText(`+£${dayIncome.toLocaleString("en-GB")}`);
});

test("a student previews prices live, raises the price, and sees the backlash and the lock count down", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Wave Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  // Its first VMs rented on day 1: all its launch users are in by day 4.
  await launch(request, code, id, "iaas");
  await pinPaidUsers(id, 1_200);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/product`);
  await expect(student.getByTestId("price-lock")).toHaveText("Unlocked");
  await student.getByRole("button", { name: "Change price" }).click();
  const dialog = student.getByRole("dialog", { name: "Set your price" });
  const preview = dialog.getByTestId("price-preview");
  await expect(preview).toContainText("That's your price now");

  // 1,200 paying users at £5. A 25% rise's reaction is each customer type's weighted by its share of users: 12.5% of
  // the 70% casual users, 7.2% of the 20% enthusiasts, 3.5% of the 8% professionals and 1.9% of the 2% businesses,
  // 10.5% in all. It affects 126 of them over the wave: 55 leave and 71 drop to free, leaving 1,074 paying £6.25 a
  // month, £224 a day.
  const input = dialog.getByLabel("Monthly price per paying user (£)");
  await input.fill("6.25");
  await expect(preview.getByTestId("preview-left")).toHaveText("55");
  await expect(preview.getByTestId("preview-to-free")).toHaveText("71");
  await expect(preview.getByTestId("preview-income")).toHaveText("£224");
  await expect(preview.getByTestId("preview-reaction")).toHaveText(
    "Price reaction: 10.5% of paying users. That's each customer type's reaction weighted by its share of users: casual users 12.5% × 70%, enthusiasts 7.2% × 20%, professionals 3.5% × 8%, businesses 1.9% × 2%.",
  );
  // The effect in one sentence, against today's £200 a day.
  await expect(preview.getByTestId("price-verdict")).toHaveText(
    "At £6.25 you'd make £24 a day more than now (£224 a day) once the wave settles. 55 paying users leave and 71 drop to free.",
  );
  await expect(preview.getByRole("img", { name: /The wave day by day/ })).toBeVisible();
  // A cut previews a positive wave instead, updating as the price changes.
  await input.fill("4");
  await expect(preview.getByTestId("preview-joined")).toBeVisible();
  await expect(preview.getByTestId("preview-upgraded")).toBeVisible();
  await expect(preview.getByTestId("preview-left")).toBeHidden();
  // Each price tried is listed to compare, the best marked; a quick step tries another in one click.
  const compare = dialog.getByTestId("price-compare");
  await expect(compare.getByRole("row")).toHaveCount(3);
  await expect(compare.getByRole("row", { name: /£6\.25/ })).toContainText("Most income");
  await dialog.getByTestId("price-quick").getByRole("button", { name: /\+10%/ }).click();
  await expect(input).toHaveValue("5.5");
  await expect(preview.getByTestId("price-tiny-step")).toBeHidden();
  await expect(compare.getByRole("row")).toHaveCount(4);

  await input.fill("6.25");
  await expect(preview.getByTestId("preview-left")).toHaveText("55");
  await dialog.getByRole("button", { name: "Set price" }).click();
  await expect(dialog).toBeHidden();
  await expect(student.getByTestId("price")).toHaveText("£6.25");
  await expect(student.getByTestId("price-lock")).toHaveText("14 days");
  await expect(student.getByTestId("wave-progress")).toContainText("Starts tomorrow");

  // The next day the backlash starts and the lock counts down.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("wave-progress")).toContainText("Day 1 of 7");
  await expect(student.getByTestId("price-lock")).toHaveText("13 days");

  // Locked: the modal still previews, but won't set a new price.
  await student.getByRole("button", { name: "Preview a price" }).click();
  await expect(dialog.getByTestId("price-locked-note")).toContainText("locked for 13 days more");
  await expect(dialog.getByRole("button", { name: "Set price" })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel" }).click();

  // Home has a card for the wave, and Customers shows its effect on users.
  await goTo(student, "Home");
  await expect(student.getByTestId("home-wave")).toContainText("Day 1");
  await goTo(student, "Customers");
  await expect(student.getByTestId("customers-wave")).toContainText("Your price rise has cost");
  // The customer mix: £6.25 is over the casual users' £5 threshold, and right on the enthusiasts'.
  const mix = student.getByTestId("customer-mix");
  await expect(mix.getByTestId("mix-over")).toContainText("above what casual users think it's worth");
  await expect(mix.locator('tr[data-type="casual"] td').last()).toHaveText(/^\s*£5\s*you're over\s*$/);
  await expect(mix.locator('tr[data-type="enthusiasts"]')).not.toContainText("you're over");
});

test("a SaaS company without support builds a backlog, hires support from Home and sees it cleared", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // A shop on SaaS: the provider runs the platform, but answering customers is still the company's job. Let its one
  // support person go, so nobody answers the shoppers' tickets.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Helpdesk Ltd", productType: "ecommerce", model: "saas" },
  });
  const { id } = await created.json();
  // SaaS needs nothing set up: the shop's 3,000 users arrive over days 1 to 3, answered as they come.
  await launch(request, code, id, "saas");
  await request.post(`/api/codes/${code}/companies/${id}/actions`, { data: { type: "letGo", pool: "support" } });

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("home-satisfaction")).toHaveText("100%");
  await expect(student.getByTestId("home-backlog")).toContainText("Backlog 0 tickets");
  for (let day = 4; day <= 6; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  // Three days of unanswered tickets: a backlog, and satisfaction on its way down.
  await expect(student.getByTestId("home-backlog")).not.toContainText("Backlog 0 tickets");
  await expect(student.getByTestId("home-satisfaction")).not.toHaveText("100%");
  await expect(student.getByTestId("home-alerts")).toContainText("Support: 1 short");

  // The Satisfaction card opens a modal with a quick hire. Juniors start soonest, in 3 days.
  await student.getByRole("button", { name: "Satisfaction" }).click();
  const modal = student.getByRole("dialog", { name: "Satisfaction" });
  await expect(modal.getByTestId("backlog")).not.toHaveText("0");
  await modal.getByRole("radio", { name: "Junior" }).check();
  // Six days' tickets by the time they start, and that day's: ten juniors, each doing 0.65 of a mid's 30, clear them.
  for (let i = 0; i < 10; i++) await modal.getByRole("button", { name: "Hire one junior support person" }).click();
  await expect(modal.getByTestId("support-hiring")).toContainText("10 junior hired: start on day 9, in 3 days.");
  await expect(modal.getByTestId("support-count")).toHaveText("0");
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(modal).toHaveCount(0);

  for (let day = 7; day <= 9; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await expect(student.getByTestId("home-backlog")).toContainText("Backlog 0 tickets");
  await expect(student.getByTestId("home-satisfaction")).toHaveText(/^\d{1,3}%$/);

  // Customers shows the day's tickets, what support cleared, the backlog and the satisfaction meter.
  await goTo(student, "Customers");
  const care = student.getByTestId("support");
  await expect(care.getByTestId("satisfaction")).toHaveText(/^\d{1,3}%$/);
  await expect(care.getByTestId("satisfaction-change")).toContainText("on day 9");
  await expect(care.getByTestId("backlog")).toHaveText("0");
  await expect(care.getByTestId("tickets-today")).toHaveText(/^\d+$/);
  await expect(care.getByTestId("cleared-today")).not.toHaveText("0");
  await expect(care.getByRole("meter", { name: "Customer satisfaction" })).toBeVisible();

  // People has the support pool with its day rate and how many tickets each person clears.
  await goTo(student, "People");
  await expect(student.getByTestId("support-count")).toHaveText("10");
  await expect(student.getByTestId("support-junior-count")).toHaveText("10");
  await expect(student.locator('[data-pool="support"]')).toContainText("Mids: £100 each a day");
  await expect(student.getByTestId("support-hint")).toContainText("A mid clears 30 tickets a day");
});

test("free users start paying each day, and Customers shows what's helping or hurting", async ({ browser, request }) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // A social network: about 2,800 of the 4,000 users who have arrived by day 4 are free.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Upgrade Ltd", productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  await launch(request, code, id, "iaas");

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("home-conversions")).toContainText(/^\d+ free users? started paying/);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`5 of ${E2E_FINAL_DAY}`);
  await expect(student.getByTestId("home-conversions")).toContainText(/[1-9]\d* free users? started paying on day 5/);

  // Customers shows the day's conversions, the rate, and each driver: with 100% uptime and satisfaction, those help.
  await goTo(student, "Customers");
  const panel = student.getByTestId("conversion");
  await expect(panel.getByTestId("conversions-today")).toHaveText(/^[1-9]\d*$/);
  await expect(panel.getByTestId("conversion-rate")).toHaveText(/^\d+\.\d\d%$/);
  const drivers = panel.getByTestId("conversion-drivers");
  await expect(drivers.locator("li")).toHaveCount(4);
  await expect(drivers.locator('[data-driver="uptime"]')).toHaveClass(/helping/);
  await expect(drivers.locator('[data-driver="satisfaction"]')).toHaveClass(/helping/);
  await expect(drivers.locator('[data-driver="features"]')).toContainText("No features live yet");
  await expect(drivers.locator('[data-driver="price"]')).toContainText("No effect");

  // The customer mix: a bar of the social network's mix, with each type's price threshold marked on a scale.
  const mix = student.getByTestId("customer-mix");
  await expect(mix.getByRole("img")).toHaveAttribute("aria-label", "Casual users 70%, Enthusiasts 20%, Professionals 8%, Businesses 2%");
  await expect(mix.getByTestId("mix-thresholds").locator(".mix-threshold")).toHaveText(["£5", "£6.25", "£10", "£15"]);
  await expect(mix.getByTestId("mix-over")).toBeHidden();

  // The day log says so too.
  await expect((await openDayLog(student)).locator('[data-kind="conversion"]')).toContainText("Free to paid:");
});
