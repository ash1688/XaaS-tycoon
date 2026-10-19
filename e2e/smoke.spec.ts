import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

test("teacher creates a code, student starts a game and presses Continue", async ({ browser }) => {
  // Teacher
  const teacher = await (await browser.newContext()).newPage();
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
  await expect(student.getByTestId("day")).toContainText("1 of 180");
  await expect(student.getByText("You're the customer of the layer below.")).toBeVisible();
  const stack = student.getByTestId("stack");
  await expect(stack.locator('[data-layer="os"]')).toContainText("OS and patching");
  await expect(stack.locator('[data-layer="os"]')).toContainText("You");
  await expect(stack.locator('[data-layer="hardware"]')).toContainText("Provider");
  // £250,000 starting cash less IaaS's £2,000 upfront cost.
  await expect(student.getByTestId("cash")).toHaveText("£248,000");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,000");
  await expect(student.getByTestId("model-costs")).toContainText("£6,000 a month");

  // Users, uptime and load vs capacity. A social network starts with 1,000 users.
  await expect(student.getByTestId("users")).toHaveText("1,000");
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  await expect(student.getByRole("meter", { name: "Load vs capacity" })).toBeVisible();
  // IaaS is 1 ops short, so its capacity is cut.
  await expect(student.getByTestId("capacity")).toContainText("1,500 / 63,000");

  // Staff: IaaS needs 2 ops and a new company starts with 1, so it's understaffed.
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  await expect(student.getByTestId("ops-needed")).toContainText("Understaffed");
  await student.getByRole("button", { name: "Hire one developer" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("3");
  await expect(student.getByTestId("staff-cost")).toHaveText("£620");

  // Features: IaaS builds them in developer-days, one at a time.
  const features = student.getByTestId("features");
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "notStarted");
  await student.getByRole("button", { name: "Build Photo sharing" }).click();
  await expect(features.locator('[data-feature="photos"]')).toHaveAttribute("data-status", "building");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("0 of 16 developer-days");
  await expect(student.getByRole("button", { name: "Build Groups" })).toBeDisabled();

  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  // £200 IaaS running costs (£6,000 a month ÷ 30) + 3 developers × £160 + 1 ops × £140.
  await expect(student.getByTestId("cash")).toHaveText("£247,180");
  const dayLog = student.getByTestId("day-log");
  await expect(dayLog.locator('[data-category="staff"]')).toContainText("Developers pay (3)");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("running costs");
  // Spend so far, split by category.
  await expect(student.getByTestId("spend-staff")).toHaveText("£620");
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,200");
  await expect(student.getByTestId("spend-addons")).toHaveText("£0");
  await expect(student.getByTestId("spend-total")).toHaveText("£2,820");
  // Users grow each day; load stays well under capacity, so uptime stays at 100%.
  await expect(student.getByTestId("users")).not.toHaveText("1,000");
  await expect(student.getByTestId("users")).toHaveText(/^1,\d{3}$/);
  await expect(student.getByTestId("uptime")).toHaveText("100%");
  // 3 developers did 3 developer-days on the build; 13 left at 3 a day is 5 days.
  await expect(student.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");
  await expect(student.getByTestId("feature-progress-photos")).toContainText("5 days left with 3 developers");
  await expect(student.getByRole("progressbar", { name: "Photo sharing" })).toHaveAttribute("aria-valuenow", "3");
  await expect(dayLog).toContainText("Building Photo sharing: 3 of 16 developer-days done.");

  // Resume in a fresh browser: the server kept the game.
  const elsewhere = await (await browser.newContext()).newPage();
  await elsewhere.goto("/");
  await elsewhere.getByLabel("Login code").fill(code!);
  await elsewhere.getByRole("button", { name: "Go" }).click();
  await elsewhere.getByRole("link", { name: /Playwright Ltd/ }).click();
  await expect(elsewhere.getByTestId("day")).toContainText("2 of 180");
  await expect(elsewhere.getByTestId("developers-count")).toHaveText("3");
  await expect(elsewhere.getByTestId("users")).not.toHaveText("1,000");
  await expect(elsewhere.getByTestId("feature-progress-photos")).toContainText("3 of 16 developer-days");

  // Teacher sees the company counted against the code.
  await teacher.reload();
  await expect(teacher.locator(`tr:has(td[data-code="${code}"]) td`).nth(1)).toHaveText("1");
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
  await expect(student.getByTestId("day-log").getByTestId("bankrupt")).toContainText("Broke Ltd is bankrupt");
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(student.getByRole("button", { name: "Hire one developer" })).toBeDisabled();

  // Still bankrupt after a reload, and the API refuses to carry on.
  await student.reload();
  await expect(student.getByTestId("bankrupt-screen")).toBeVisible();
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
  const shop = student.getByTestId("features");
  await expect(shop.getByRole("heading", { name: "Add-on shop" })).toBeVisible();
  await expect(student.getByTestId("addon-price-messaging")).toContainText("£0.08 per user a month");
  await expect(student.getByTestId("addon-bill")).toContainText("£0 a month");

  // Add-ons need a configuration team of 2 developers: with 1, they can't be bought.
  await expect(student.getByTestId("config-team")).toContainText("at least 2 developers");
  await student.getByRole("button", { name: "Let go one developer" }).click();
  await expect(student.getByTestId("config-team")).toContainText("Hire 1 more to buy add-ons");
  await expect(student.getByRole("button", { name: "Buy Direct messages add-on" })).toBeDisabled();
  await student.getByRole("button", { name: "Hire one developer" }).click();

  // Bought add-ons are active at once. 1,000 users at £0.08 is £80 a month.
  await student.getByRole("button", { name: "Buy Direct messages add-on" }).click();
  await expect(shop.locator('[data-feature="messaging"]')).toHaveAttribute("data-status", "addon");
  await expect(shop.locator('[data-feature="messaging"]')).toContainText("Active");
  await expect(student.getByTestId("addon-bill")).toContainText("£80 a month");
  await expect(student.getByTestId("model-costs")).toContainText("£80 a month for add-ons");

  // A day's share of the add-on bill: £80 ÷ 30, rounded to £3, tagged add-ons.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  await expect(student.getByTestId("day-log").locator('[data-category="addons"]')).toContainText(
    "Add-on: Direct messages (1,000 users at £0.08 a month)",
  );
  await expect(student.getByTestId("spend-addons")).toHaveText("£3");
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
  await student.goto(`/play/${code}/${id}`);
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
  await expect(student.getByTestId("spend-infrastructure")).toHaveText("£2,000");
  await student.getByRole("button", { name: "Start migration" }).click();
  await expect(quote).toHaveCount(0);

  await expect(student.getByTestId("migration-target")).toHaveText("Deploy to a platform (PaaS)");
  await expect(student.getByTestId("migration-phase")).toHaveText("Planning");
  await expect(student.getByTestId("migration-phase-days")).toHaveText("5 days left");
  await expect(student.getByTestId("migration-days-left")).toHaveText("14 days");
  await expect(student.getByTestId("stack-note")).toContainText("changes to Deploy to a platform (PaaS)");

  // Staff aren't tied up: move a developer into ops mid-migration.
  await expect(student.getByTestId("developers-count")).toHaveText("2");
  await student.getByRole("button", { name: "Move one developer to ops staff" }).click();
  await expect(student.getByTestId("developers-count")).toHaveText("1");
  await expect(student.getByTestId("ops-count")).toHaveText("2");

  const continueTo = async (day: number) => {
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`${day} of 180`);
  };
  for (let day = 2; day <= 6; day++) await continueTo(day);
  await expect(student.getByTestId("migration-phase")).toHaveText("Testing");
  await expect(student.getByTestId("migration-phase-days")).toHaveText("2 days left");
  await expect(student.getByTestId("migration-days-left")).toHaveText("9 days");
  await expect(student.getByTestId("day-log")).toContainText("Planning done. Testing next, 2 days.");
  await expect(panel.locator('[data-phase="planning"]')).toContainText("Done");
  // Still on IaaS, and billed for it, until the move completes; PaaS is billed in full on top.
  await expect(student.getByTestId("ops-needed")).toContainText("needs 2 ops staff");
  const infrastructure = student.getByTestId("day-log").locator('[data-category="infrastructure"]');
  await expect(infrastructure).toContainText("Rent VMs (IaaS) running costs");
  await expect(infrastructure).toContainText("Double billing: Deploy to a platform (PaaS) running costs");

  // Moving starts on day 8. Seeds are random here, so it may overrun: if so, the panel shows the extra days.
  for (let day = 7; day <= 8; day++) await continueTo(day);
  const daysLeft = Number((await student.getByTestId("migration-days-left").textContent())!.split(" ")[0]);
  if (daysLeft > 7) await expect(student.getByTestId("migration-overrun")).toContainText(`${daysLeft - 7} days`);
  else await expect(student.getByTestId("migration-overrun")).toHaveCount(0);
  for (let day = 9; day <= 8 + daysLeft; day++) await continueTo(day);
  await expect(student.getByTestId("day-log")).toContainText("Migration complete");
  await expect(panel).toContainText("1 completed");
  await expect(student.getByTestId("ops-needed")).toContainText("needs 1 ops staff");
  await expect(stack.locator('[data-layer="os"]')).toContainText("Provider");
  await expect(stack.locator('[data-layer="os"]')).toContainText("was You");
  await expect(student.getByTestId("model-costs")).toContainText("£9,000 a month");
  await expect(student.getByTestId("day-log")).toContainText("Exit penalty: leaving Rent VMs (IaaS)");
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
  await student.goto(`/play/${code}/${id}`);
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
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("button", { name: "Buy Direct messages add-on" }).click();
  await expect(student.getByTestId("features").locator('[data-feature="messaging"]')).toHaveAttribute(
    "data-status",
    "addon",
  );

  // The confirm step for IaaS warns, by name, which add-ons stay behind and why.
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
  await expect(student.getByTestId("day")).toContainText("2 of 180");
  await expect(student.getByTestId("event-card")).toHaveCount(0);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("3 of 180");

  const card = student.getByTestId("event-card");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-event", "osPatch");
  await expect(card.getByRole("strong").first()).toHaveText("OS security patch");
  await expect(card.getByTestId("event-responsibility")).toHaveText("OS and patching is your job on-prem.");
  await expect(card.getByTestId("event-outcome")).toContainText("attackers got in");
  await expect(card.getByTestId("event-tone")).toHaveText("It hurt");
  // The layer that decided it is highlighted in the stack, and the card links to it.
  const os = student.getByTestId("stack").locator('[data-layer="os"]');
  await expect(os).toHaveAttribute("data-event", "osPatch");
  await expect(os).toContainText("OS security patch");
  await card.getByRole("button", { name: "See OS and patching in the stack" }).click();
  await expect(os).toBeFocused();
  // It's in the day log too, with the outage and clean-up it caused.
  const dayLog = student.getByTestId("day-log");
  await expect(dayLog.getByTestId("event")).toContainText("OS and patching is your job on-prem.");
  await expect(dayLog.getByTestId("outage")).toContainText("OS security patch");
  await expect(dayLog.locator('[data-category="infrastructure"]')).toContainText("Cleaning up after the break-in");

  // Gone the next day.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("4 of 180");
  await expect(student.getByTestId("event-card")).toHaveCount(0);
  await expect(os).not.toHaveAttribute("data-event", "osPatch");

  // On PaaS the same day's patch is the provider's job: nothing to do.
  await student.goto(`/play/${code}/${paas}`);
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("2 of 180");
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
    await expect(student.getByTestId("day")).toContainText(`${day} of 180`);
  }

  const card = student.getByTestId("event-card").and(student.locator('[data-event="saasFeatureGap"]'));
  await expect(card).toBeVisible();
  await expect(card.getByRole("strong").first()).toHaveText("A feature SaaS can't provide");
  await expect(card.getByTestId("event-responsibility")).toHaveText(
    "Application / features is shared between you and the provider on SaaS.",
  );
  await expect(card.getByTestId("event-outcome")).toContainText("a feed that ranks posts your way, and no add-on offers it");
  await expect(card.getByTestId("event-tone")).toHaveText("It hurt");
  const application = student.getByTestId("stack").locator('[data-layer="application"]');
  await expect(application).toHaveAttribute("data-event", "saasFeatureGap");
  await expect(student.getByTestId("day-log").getByTestId("event")).toContainText("A feature SaaS can't provide");

  // The next day the card has gone, but the gap is still on screen, in the stack and in the add-on shop.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText("7 of 180");
  await expect(card).toHaveCount(0);
  const gap = student.getByTestId("feature-gap");
  await expect(gap).toBeVisible();
  await expect(gap).toContainText("Growth is 20% slower every day until you migrate");
  await expect(application).toHaveAttribute("data-gap", "saasFeatureGap");
  await expect(application).toContainText("Feature gap");
  await expect(student.getByTestId("gap-shop-note")).toContainText("a feed that ranks posts your way");
  await gap.getByRole("button", { name: "See Application / features in the stack" }).click();
  await expect(application).toBeFocused();
});
