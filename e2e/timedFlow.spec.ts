// Runs in the "timed" project, against a server with timed flow on and a short interval.
import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD, E2E_TIMED_FLOW_SECONDS } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

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
  await expect(student.getByTestId("timed-status")).toContainText(`A day plays every ${E2E_TIMED_FLOW_SECONDS}s`);
  await student.getByLabel("Speed").selectOption("Slow");
  await expect(student.getByTestId("timed-status")).toContainText(`A day plays every ${2 * E2E_TIMED_FLOW_SECONDS}s`);
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
  const { code, id } = await newCompany(browser, request, "Pay Day Ltd");
  // Day 6 of 30, with cash to spare: the first review opens after day 7, before quarter 2 starts on day 8.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{day}', '6'::jsonb), '{cash}', '500000'::jsonb) where id = ${id}`;
  } finally {
    await sql.end();
  }

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  await student.getByLabel("Speed").selectOption("Fastest");
  await student.getByRole("button", { name: "Play" }).click();
  const modal = student.getByRole("dialog", { name: "Pay review" });
  await expect(modal).toBeVisible({ timeout: 15_000 });
  await expect(student.getByTestId("day")).toContainText(`7 of ${E2E_FINAL_DAY}`);
  await expect(modal).toContainText("Quarter 2 starts on day 8, and your staff want to talk about pay.");
  await expect(modal.getByTestId("pay-inflation")).toHaveText(/^\d\.\d%$/);
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
  // An offer of staff's whole ask is always accepted.
  await modal.getByTestId("pay-rise").fill(maxAsk);
  await expect(modal.getByTestId("pay-meets-ask")).toBeVisible();
  await modal.getByTestId("pay-offer").click();
  await expect(modal.getByTestId("pay-settled")).toContainText(`Pay review settled on a ${maxAsk}% rise.`);
  await modal.getByTestId("pay-done").click();

  // The game plays on.
  await student.getByRole("button", { name: "Continue" }).click();
  await expect(student.getByTestId("day")).toContainText(`8 of ${E2E_FINAL_DAY}`);
});

test("a pay review with no deal after the final offer warns of the tribunal, shows its odds, and goes to it", async ({ browser, request }) => {
  const { code, id } = await newCompany(browser, request, "Tribunal Ltd");
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(jsonb_set(state, '{day}', '6'::jsonb), '{cash}', '500000'::jsonb) where id = ${id}`;
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
    await expect(student.getByTestId("day")).toContainText(`8 of ${E2E_FINAL_DAY}`);
    await expect(student.getByText(/The tribunal settled quarter 2's pay review on/)).toBeVisible();
  } finally {
    await sql.end();
  }
});
