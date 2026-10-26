// Runs in the "timed" project, against a server with timed flow on and a short interval.
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD, E2E_TIMED_FLOW_SECONDS } from "../playwright.config.ts";
import { createCode, reachPhase, withPreset } from "./staff.ts";

async function newCompany(browser: Browser, request: APIRequestContext, name: string) {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name, productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  return { code: code!, id: id as string };
}

// Pay reviews start payReview.growDays into the Grow phase (#236), a month by default: too late for a 30-day game. On
// this preset, a game put into Grow on day 7 has its first rise on day 9, the start of quarter 2.
const PAY_REVIEW_SOON = { "payReview.growDays": 2 };

/** A company on day 7, with cash to spare, whose first pay review opens once the day is played (see dueReview). */
async function newCompanyForReview(browser: Browser, request: APIRequestContext, name: string) {
  const company = await withPreset(request, "Pay review soon", PAY_REVIEW_SOON, () => newCompany(browser, request, name));
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{day}', '7'::jsonb), '{cash}', '500000'::jsonb) where id = ${company.id}`;
  } finally {
    await sql.end();
  }
  return company;
}

/** Puts a company from newCompanyForReview into Grow today, day 7, so its first pay review opens after day 8. */
const dueReview = (id: string) => reachPhase(id, "grow");

const dayOf = async (text: Promise<string>) => Number((await text).match(/^\d+/)![0]);

test("with timed flow on, days play by themselves at the speed picked, and Pause stops them", async ({ browser, request }) => {
  const meta = await (await request.get("/api/meta")).json();
  expect(meta.timedFlow).toMatchObject({ enabled: true, seconds: E2E_TIMED_FLOW_SECONDS });
  expect(meta.timedFlow.speeds.map((s: { name: string }) => s.name)).toEqual(["Slow", "Normal", "Fast", "Fastest"]);

  const { code, id } = await newCompany(browser, request, "Clockwork Ltd");
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("day")).toContainText(`1 of ${E2E_FINAL_DAY}`);
  // A game opens paused, at normal speed.
  await expect(student.getByTestId("timed-status")).toContainText(`Play: a day every ${E2E_TIMED_FLOW_SECONDS}s`);
  await student.getByLabel("Speed").selectOption("Slow");
  await expect(student.getByTestId("timed-status")).toContainText(`Play: a day every ${2 * E2E_TIMED_FLOW_SECONDS}s`);
  await student.getByLabel("Speed").selectOption("Normal");

  // Play from the keyboard: the countdown shows and days advance with no clicks on Continue.
  await student.getByRole("button", { name: "Play" }).focus();
  await student.keyboard.press("Enter");
  await expect(student.getByRole("timer")).toContainText("Next day in");
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect.poll(async () => dayOf(student.getByTestId("day").innerText()), { timeout: 10_000 }).toBeGreaterThan(1);
  // Actions still work while it plays, on any page.
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "People" }).click();
  await student.getByRole("button", { name: "Hire one mid developer" }).click();
  await expect(student.getByTestId("developers-hiring")).toContainText("1 mid hired");

  // Unless it has paused itself already, for something that needs the student.
  const pauseButton = student.getByRole("button", { name: "Pause" });
  if (await pauseButton.isVisible()) await pauseButton.click();
  await expect(student.getByTestId("timed-status")).toContainText("Paused");
  // A request already in flight may still land, then nothing more.
  await student.waitForTimeout(1_200);
  const paused = await dayOf(student.getByTestId("day").innerText());
  await student.waitForTimeout(2_500);
  expect(await dayOf(student.getByTestId("day").innerText())).toBe(paused);

  // Continue still steps a single day while paused.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`${paused + 1} of ${E2E_FINAL_DAY}`);
});

test("timed flow pauses itself when something needs the student, and says why", async ({ browser, request }) => {
  const { code, id } = await newCompany(browser, request, "Alarm Clock Ltd");
  // Cash for about 9 days at this company's costs (£460 of staff and £1,000 a month of infrastructure a day, with no
  // users yet): it runs low a few days into playing.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{cash}', '4500'::jsonb) where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByLabel("Speed").selectOption("Fastest");
  await student.getByRole("button", { name: "Play" }).click();
  const reasons = student.getByTestId("pause-reasons");
  await expect(reasons).toBeVisible({ timeout: 15_000 });
  await expect(reasons).toContainText(/Time stopped on day \d+, \w+ \d+ \w+ \d{4}, because something needs you/);
  await expect(reasons.getByRole("listitem").first()).toBeVisible();
  await expect(reasons).toContainText(/Cash runs out/);
  await expect(student.getByRole("button", { name: "Play" })).toBeVisible();
  await expect(student.getByTestId("timed-status")).toContainText("Paused");
  // Stays paused until the student plays on, which clears the reasons.
  const stopped = await dayOf(student.getByTestId("day").innerText());
  await student.waitForTimeout(1_000);
  expect(await dayOf(student.getByTestId("day").innerText())).toBe(stopped);
  await student.getByRole("button", { name: "Play" }).click();
  await expect(reasons).toHaveCount(0);
});

test("timed flow stops when the game ends", async ({ browser, request }) => {
  const { code, id } = await newCompany(browser, request, "Last Orders Ltd");
  // One day from the end, as if it had played the rest already.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{day}', ${String(E2E_FINAL_DAY - 1)}::jsonb) where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await expect(student.getByTestId("day")).toContainText(`${E2E_FINAL_DAY - 1} of ${E2E_FINAL_DAY}`);
  await student.getByRole("button", { name: "Play" }).click();
  await expect(student.getByTestId("finished-screen")).toBeVisible({ timeout: 10_000 });
  await expect(student.getByTestId("timed-flow")).toHaveCount(0);
  await expect(student.getByTestId("summary")).toBeVisible();
  // Nothing else is sent once it has ended.
  let continues = 0;
  student.on("request", (r) => r.url().endsWith("/continue") && continues++);
  await student.waitForTimeout(2_500);
  expect(continues).toBe(0);
});

test("a pay review stops timed flow and holds the game until the student settles it in its modal", async ({ browser, request }) => {
  // Day 7 of 30, with cash to spare: the first review opens after day 8, before quarter 2 starts on day 9.
  const { code, id } = await newCompanyForReview(browser, request, "Pay Day Ltd");
  await dueReview(id);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByLabel("Speed").selectOption("Fastest");
  await student.getByRole("button", { name: "Play" }).click();
  const modal = student.getByRole("dialog", { name: "Pay review" });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(student.getByTestId("day")).toContainText(`8 of ${E2E_FINAL_DAY}`);
  await expect(modal).toContainText("Your staff want to talk about pay (Quarter 2), with the rise from day 9.");
  await expect(modal.getByTestId("pay-inflation")).toHaveText(/^\d\.\d%$/);
  await expect(modal.getByTestId("pay-dealing-directly")).toContainText("You're dealing with staff directly");
  const maxAsk = (await modal.getByTestId("pay-max-ask").innerText()).replace("%", "");

  // Closed to look around, the game still holds, and a note opens it again.
  await modal.getByRole("button", { name: "Close" }).click();
  await expect(student.getByRole("button", { name: "Continue" })).toBeDisabled();
  await expect(student.getByTestId("timed-flow")).toHaveCount(0);
  await student.getByTestId("pay-review-open").click();

  // An offer below their ask shows its cost and the odds on staff's counter before it's made.
  const minOffer = (await modal.getByTestId("pay-min-offer").innerText()).replace("%", "");
  await modal.getByTestId("pay-rise").fill(minOffer);
  await expect(modal.getByTestId("pay-cost")).toContainText(/That adds £[\d,]+ a day to your team's cost: £[\d,]+ a year/);
  await expect(modal.getByTestId("pay-odds-high")).toContainText(/High roll, \d+%/);
  // A staff scheme with it: what it's worth to staff and what it costs a day, for good.
  await modal.getByTestId("pay-scheme-pension-input").fill("2");
  await expect(modal.getByTestId("pay-worth")).toContainText(/Worth \d\.\d% to your staff: [\d.]+% cash plus 1\.05% for the schemes/);
  await expect(modal.getByTestId("pay-scheme-cost-pension")).toContainText(/£[\d,]+ a day, for good/);
  await expect(modal.getByTestId("pay-offer")).toContainText("+ 1 scheme");
  await modal.getByTestId("pay-scheme-deathInService-input").check();
  await expect(modal.getByTestId("pay-offer")).toContainText("+ 2 schemes");
  // Not given yet, so they can come back off.
  await modal.getByTestId("pay-scheme-deathInService-input").uncheck();
  await modal.getByTestId("pay-scheme-pension-input").fill("0");
  await expect(modal.getByTestId("pay-worth")).toHaveCount(0);
  // Share save is paid for in ownership: the preview shows the dilution before the offer.
  await modal.getByTestId("pay-scheme-shareSave-input").fill("2");
  await expect(modal.getByTestId("pay-dilution")).toContainText(/Share save issues [\d,]+ new shares to the staff share scheme, which would own 2\.0% of your company\. You'd own 98\.0%, down from 100\.0%/);
  await modal.getByTestId("pay-scheme-shareSave-input").fill("0");
  await expect(modal.getByTestId("pay-dilution")).toHaveCount(0);
  // An offer of staff's whole ask is always accepted.
  await modal.getByTestId("pay-rise").fill(maxAsk);
  await expect(modal.getByTestId("pay-meets-ask")).toBeVisible();
  await modal.getByTestId("pay-offer").click();
  await expect(modal.getByTestId("pay-settled")).toContainText(`Pay review settled on a ${maxAsk}% rise.`);
  await modal.getByTestId("pay-done").click();

  // The game plays on.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`9 of ${E2E_FINAL_DAY}`);
});

test("a pay review with no deal after the final offer warns of the tribunal, shows its odds, and goes to it", async ({ browser, request }) => {
  const { code, id } = await newCompanyForReview(browser, request, "Tribunal Ltd");
  await dueReview(id);
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const student = await (await browser.newContext()).newPage();
    await student.goto(`/play/${code}/${id}`);
    await student.getByRole("button", { name: "Continue" }).click();
    const modal = student.getByRole("dialog", { name: "Pay review" });
    await expect(modal).toBeVisible();
    // Staff hold out for their whole ask, so no lower offer reaches a deal.
    await sql`update companies set state = jsonb_set(state, '{payReview,walkAway}', state #> '{payReview,maxAsk}') where id = ${id}`;
    await student.reload();
    await expect(modal).toBeVisible();

    const minOffer = (await modal.getByTestId("pay-min-offer").innerText()).replace("%", "");
    for (const left of ["3 offers left", "2 offers left"]) {
      await expect(modal.getByTestId("pay-final-warning")).toHaveCount(0);
      await modal.getByTestId("pay-rise").fill(minOffer);
      await expect(modal.getByTestId("pay-offer")).toContainText(left);
      await expect(modal.getByTestId("pay-odds-high")).toBeVisible();
      await modal.getByTestId("pay-offer").click();
      await expect(modal.getByTestId("pay-counter")).toBeVisible();
    }
    // Before the final offer: a clear warning that the next step is a tribunal, with its fee, and its odds.
    await expect(modal.getByTestId("pay-final-warning")).toContainText("next is a tribunal");
    await expect(modal.getByTestId("pay-final-warning")).toContainText("£2,000");
    await modal.getByTestId("pay-rise").fill(minOffer);
    await expect(modal.getByTestId("pay-tribunal-odds")).toBeVisible();
    for (const [pick, label] of [["student", "Your offer"], ["middle", "The middle"], ["staff", "Staff's figure"]]) {
      await expect(modal.getByTestId(`pay-tribunal-${pick}`)).toContainText(new RegExp(`${label}, \\d+%\\s*a \\d\\.\\d% rise`));
    }
    await modal.getByTestId("pay-offer").click();
    await expect(modal.getByTestId("pay-tribunal-result")).toContainText(/the tribunal sat and picked (your offer|the middle|staff's figure)\. Its fee of £2,000/);
    await expect(modal.getByTestId("pay-settled")).toContainText(/Pay review settled on a \d\.\d% rise\./);
    await modal.getByTestId("pay-done").click();

    // The clock is free again, and the next day's log says what the tribunal did.
    await student.getByRole("button", { name: "Continue" }).click();
    await expect(student.getByTestId("day")).toContainText(`9 of ${E2E_FINAL_DAY}`);
    await expect(student.getByText(/The tribunal settled quarter 2's pay review on/)).toBeVisible();

    // The pay history on the People page has it, with the tribunal's pick and fee.
    await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "People" }).click();
    const row = student.getByTestId("pay-history").getByTestId("pay-history-q2");
    await expect(row.getByTestId("pay-history-ended")).toContainText(/Tribunal picked (your offer|the middle|staff's figure)/);
    await expect(row.getByTestId("pay-history-fee")).toContainText("tribunal fee £2,000");
    await expect(student.getByTestId("pay-history-fees")).toContainText("Tribunal fees paid: £2,000.");
  } finally {
    await sql.end();
  }
});

/** A company whose first pay review is open, with staff's walk-away figure set to `walkAway` (their ask or the least offer). */
async function reviewWith(browser: Browser, request: APIRequestContext, name: string, walkAway: "maxAsk" | "minOffer") {
  const { code, id } = await newCompanyForReview(browser, request, name);
  await dueReview(id);
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    const student = await (await browser.newContext()).newPage();
    await student.goto(`/play/${code}/${id}`);
    await student.getByRole("button", { name: "Continue" }).click();
    const modal = student.getByRole("dialog", { name: "Pay review" });
    await expect(modal).toBeVisible();
    await (walkAway === "maxAsk"
      ? sql`update companies set state = jsonb_set(state, '{payReview,walkAway}', state #> '{payReview,maxAsk}') where id = ${id}`
      : sql`update companies set state = jsonb_set(state, '{payReview,walkAway}', state #> '{payReview,minOffer}') where id = ${id}`);
    await student.reload();
    await expect(modal).toBeVisible();
    return { code, id, modal };
  } finally {
    await sql.end();
  }
}

test("auto-negotiating a pay review stops on staff's last counter with Accept and Tribunal, and the tribunal goes by hand", async ({
  browser,
  request,
}) => {
  // Staff hold out for their whole ask, so the least offer never settles it.
  const { code, id, modal } = await reviewWith(browser, request, "Auto Pay Ltd", "maxAsk");
  const minOffer = (await modal.getByTestId("pay-min-offer").innerText()).replace("%", "");
  await modal.getByTestId("pay-rise").fill(minOffer);
  await expect(modal.getByTestId("pay-odds-high")).toBeVisible();
  await modal.getByTestId("pay-auto-negotiate").click();

  // Two offers of the same rise, each answered by a counter, and it stops before the final offer.
  const transcript = modal.getByTestId("pay-auto-transcript");
  await expect(transcript).toContainText(`Offer 1 (${minOffer}%): they `);
  await expect(transcript).toContainText(`Offer 2 (${minOffer}%): they `);
  await expect(modal.getByTestId("pay-round")).toHaveCount(2);
  await expect(modal.getByTestId("pay-final-warning")).toContainText("next is a tribunal");
  await expect(modal.getByTestId("pay-auto-negotiate")).toBeHidden();
  await expect(modal.getByTestId("pay-final-accept")).toContainText(/Accept \d+\.\d%/);
  await expect(modal.getByTestId("pay-tribunal")).toHaveText("Tribunal (£2,000 fee)");
  const { cash } = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();

  // The tribunal is the student's button: their last offer again, which staff have turned down.
  await modal.getByTestId("pay-tribunal").click();
  await expect(modal.getByTestId("pay-tribunal-result")).toContainText("Its fee of £2,000");
  const after = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(after.cash).toBe(cash - 2_000);
  expect(after.lastPayReview.outcome).toBe("tribunal");
  expect(after.lastPayReview.studentOffers).toHaveLength(3);
});

test("auto-negotiating a pay review settles it if staff accept along the way", async ({ browser, request }) => {
  // Staff take the least offer.
  const { modal } = await reviewWith(browser, request, "Agreeable Ltd", "minOffer");
  const minOffer = (await modal.getByTestId("pay-min-offer").innerText()).replace("%", "");
  await modal.getByTestId("pay-rise").fill(minOffer);
  await expect(modal.getByTestId("pay-odds-high")).toBeVisible();
  await modal.getByTestId("pay-auto-negotiate").click();
  await expect(modal.getByTestId("pay-auto-transcript")).toContainText(`Offer 1 (${minOffer}%): staff accepted.`);
  await expect(modal.getByTestId("pay-settled")).toContainText(`Pay review settled on a ${minOffer}% rise.`);
  await expect(modal.getByTestId("pay-tribunal-result")).toHaveCount(0);
});

test("staff's counter to an offer with schemes keeps them: agreeing it starts them, as the People page shows", async ({ browser, request }) => {
  // The playtest: pension, health and share save, auto-negotiated to staff's last counter, then agreed.
  const { code, id, modal } = await reviewWith(browser, request, "Perks Ltd", "maxAsk");
  const minOffer = (await modal.getByTestId("pay-min-offer").innerText()).replace("%", "");
  await modal.getByTestId("pay-rise").fill(minOffer);
  for (const id of ["pension", "health", "shareSave"]) await modal.getByTestId(`pay-scheme-${id}-input`).fill("1");
  await expect(modal.getByTestId("pay-offer")).toContainText("+ 3 schemes");
  await expect(modal.getByTestId("pay-odds-high")).toContainText(/they ask \d+\.\d% cash plus your schemes/);
  await modal.getByTestId("pay-auto-negotiate").click();

  await expect(modal.getByTestId("pay-auto-transcript")).toContainText(/Offer 1 \([\d.]+%\): they .*\d+\.\d% cash plus your schemes\./);
  const schemes = "Pension top-up to level 1, Health cash plan to level 1, Share save to level 1";
  const counter = modal.getByTestId("pay-counter");
  await expect(counter).toContainText(new RegExp(`Your staff are asking for \\d+\\.\\d% cash plus your schemes \\(${schemes}\\)\\.`));
  const cash = (await counter.locator("strong").innerText()).replace("%", "");
  await expect(modal.getByTestId("pay-accept-counter")).toHaveText(`Agree ${cash}% plus your schemes`);
  await expect(modal.getByTestId("pay-final-warning")).toContainText("Your schemes apply whichever it picks.");
  await modal.getByTestId("pay-accept-counter").click();

  await expect(modal.getByTestId("pay-settled")).toContainText(`Pay review settled on a ${cash}% rise.`);
  await expect(modal.getByTestId("pay-schemes-held")).toContainText(/Pension top-up 1 .*Health cash plan 1 .*Share save 1 /);
  await expect(modal.getByTestId("pay-share-save-issued")).toBeVisible();
  const after = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  expect(after.lastPayReview.outcome).toBe("counterAccepted");
  expect(after.lastPayReview.rise).toBeCloseTo(Number(cash) / 100, 6);
  await modal.getByTestId("pay-done").click();

  const student = modal.page();
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "People" }).click();
  const table = student.getByTestId("staff-schemes");
  for (const id of ["pension", "health", "shareSave"]) await expect(table.getByTestId(`staff-scheme-${id}`)).toContainText("Level 1 of 3");
  await expect(table.getByTestId("staff-scheme-discount")).toContainText("Off");
});

test("the People page's pay history is empty before the first review, then lists each review settled", async ({ browser, request }) => {
  const { code, id } = await newCompanyForReview(browser, request, "Payroll Ltd");
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByRole("navigation", { name: "Game" }).getByRole("link", { name: "People" }).click();
  const history = student.getByTestId("pay-history");
  // Before Grow there's no day for the first review yet.
  await expect(history.getByTestId("pay-history-empty")).toHaveText(
    "No pay reviews yet. The first comes about a month into the Grow phase, when your first angel investor has approached.",
  );
  await dueReview(id);
  await student.reload();
  await expect(history.getByTestId("pay-history-empty")).toHaveText(
    "No pay reviews yet. The first comes in quarter 2, with its rise from day 9.",
  );
  await expect(history.getByTestId("pay-multiplier")).toContainText("Pay is ×1.000 the day rates: no rises yet.");

  // Play to the review and settle it on staff's whole ask, which they always accept.
  await student.getByRole("button", { name: "Continue" }).click();
  const modal = student.getByRole("dialog", { name: "Pay review" });
  await expect(modal).toBeVisible();
  const inflation = await modal.getByTestId("pay-inflation").innerText();
  const maxAsk = (await modal.getByTestId("pay-max-ask").innerText()).replace("%", "");
  await modal.getByTestId("pay-rise").fill(maxAsk);
  await modal.getByTestId("pay-offer").click();
  await expect(modal.getByTestId("pay-settled")).toBeVisible();
  await modal.getByTestId("pay-done").click();

  await expect(history.getByTestId("pay-history-empty")).toHaveCount(0);
  const row = history.getByTestId("pay-history-q2");
  await expect(row).toContainText("Quarter 2");
  await expect(row).toContainText("(day 9)");
  await expect(row).toContainText(inflation);
  await expect(row.getByTestId("pay-history-ended")).toHaveText("Agreed: staff accepted your first offer");
  await expect(row.getByTestId("pay-history-rise")).toContainText(`${maxAsk}%`);
  await expect(row.getByTestId("pay-history-schemes")).toHaveText("none");
  await expect(row.getByTestId("pay-history-fee")).toHaveCount(0);
  const multiplier = (1 + Number(maxAsk) / 100).toFixed(3);
  await expect(history.getByTestId("pay-multiplier")).toContainText(`Pay is ×${multiplier} the day rates: +${maxAsk}% from every rise so far`);
  await expect(history.getByTestId("pay-history-next")).toContainText(/quarter 3, with its rise from day \d+\./);
});
