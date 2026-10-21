import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { E2E_DATABASE_URL, E2E_FINAL_DAY, E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { createCode } from "./staff.ts";

const money = (n: number) => n.toLocaleString("en-GB", { style: "currency", currency: "GBP", maximumFractionDigits: 0 });

test("play to the end, then see profit or loss and income against costs, and the teacher sees income and satisfaction", async ({
  browser,
  request,
}) => {
  const teacher = await (await browser.newContext()).newPage();
  await teacher.goto("/staff");
  await teacher.getByLabel("Teacher password").fill(E2E_TEACHER_PASSWORD);
  await teacher.getByRole("button", { name: "Sign in" }).click();
  const code = await createCode(teacher);

  // A shop on IaaS with the loan, which raises its price once and hires the ops it needs.
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name: "Reflect Ltd", productType: "ecommerce", model: "iaas", takeLoan: true },
  });
  expect(created.status()).toBe(201);
  const { id, fairPrice } = await created.json();
  // Plenty of cash, so it lasts the game whatever its costs: this test is about the summary, not the balance. Cash
  // isn't income, so profit is unchanged.
  const sql = postgres(E2E_DATABASE_URL, { onnotice: () => {} });
  try {
    await sql`update companies set state = jsonb_set(state, '{cash}', '200000') where id = ${id}`;
  } finally {
    await sql.end();
  }
  const act = (data: object) => request.post(`/api/codes/${code}/companies/${id}/actions`, { data });
  expect((await act({ type: "hire", pool: "ops" })).status()).toBe(200);
  expect((await act({ type: "setPrice", price: fairPrice + 5 })).status()).toBe(200);

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}`);
  for (let day = 2; day <= E2E_FINAL_DAY; day++) {
    await student.getByRole("button", { name: "Continue" }).click();
    if (day < E2E_FINAL_DAY) await expect(student.getByTestId("day")).toContainText(`${day} of ${E2E_FINAL_DAY}`);
  }
  await expect(student.getByTestId("finished-screen")).toContainText(`You made it to day ${E2E_FINAL_DAY}`);

  const api = await (await request.get(`/api/codes/${code}/companies/${id}/summary`)).json();
  expect(api).toMatchObject({ ending: "completed", priceChanges: 1, loan: { day: 1, fullyRepaid: true } });
  expect(api.income).toBeGreaterThan(0);

  // The headline: profit or loss, said in words and by its sign as well as its colour, from income less costs.
  const headline = student.getByTestId("summary-headline");
  const loss = api.profit < 0;
  await expect(headline.getByTestId("summary-result")).toHaveText(loss ? "Loss" : "Profit");
  await expect(headline.getByTestId("summary-profit")).toHaveText(`${loss ? "−" : "+"}${money(Math.abs(api.profit))}`);
  await expect(headline.getByTestId("summary-income")).toHaveText(money(api.income));
  // Of the loan repayments only the interest is a cost, so costs are less than everything spent by the principal.
  await expect(headline.getByTestId("summary-costs")).toHaveText(money(api.costs));
  expect(api.costs).toBeCloseTo(api.totalSpend - api.loan.principalRepaid, 6);
  expect(api.loan.principalRepaid).toBe(35_000);
  await expect(headline).toHaveClass(loss ? /loss/ : /profit/);

  // Peak users with the split, satisfaction and uptime on average, the price change and the loan.
  await expect(student.getByTestId("summary-peak")).toHaveText(api.peak.users.toLocaleString("en-GB"));
  await expect(student.getByTestId("summary-peak-split")).toContainText(
    `${api.peak.paidUsers.toLocaleString("en-GB")} paying, ${(api.peak.users - api.peak.paidUsers).toLocaleString("en-GB")} free`,
  );
  await expect(student.getByTestId("summary-satisfaction")).toHaveText(`${Math.round(api.satisfaction)}%`);
  await expect(student.getByTestId("summary-uptime")).toHaveText(/%$/);
  await expect(student.getByTestId("summary-price-changes")).toHaveText("1");
  await expect(student.getByTestId("summary-loan")).toHaveText("£35,000");
  await expect(student.getByTestId("summary-loan-status")).toContainText("taken at the start · repaid in full");
  await expect(student.getByTestId("summary-loan-interest")).toHaveText(`${money(api.loan.interestPaid)} interest`);

  // The income-against-costs chart: two lines, with a key and axis titles.
  const chart = student.getByTestId("income-chart");
  await expect(chart.getByRole("img", { name: "Income against costs, added up from day 1" })).toBeVisible();
  await expect(chart.getByTestId("income-chart-income")).toHaveAttribute("d", /^M.*L/);
  await expect(chart.getByTestId("income-chart-costs")).toHaveAttribute("d", /^M.*L/);
  await expect(chart.locator("rect[data-day]")).toHaveCount(E2E_FINAL_DAY);
  await expect(chart.getByRole("list", { name: "Key" })).toContainText("Income");
  await expect(chart.getByRole("list", { name: "Key" })).toContainText("Costs");
  await expect(chart).toContainText("Total so far");

  // The teacher's live dashboard: income on the last day, profit, satisfaction, paid and free users and the loan.
  const company = await (await request.get(`/api/codes/${code}/companies/${id}`)).json();
  await teacher.reload();
  const row = teacher.locator(`tr[data-company="${id}"]`);
  await expect(row.getByTestId("live-income")).toHaveText(money(api.days.at(-1).income));
  await expect(row.getByTestId("live-profit")).toHaveText(`${loss ? "−" : "+"}${money(Math.abs(api.profit))}`);
  await expect(row.getByTestId("live-satisfaction")).toHaveText(`${company.satisfaction}%`);
  await expect(row.getByTestId("live-paid-free")).toHaveText(
    `${company.paidUsers.toLocaleString("en-GB")} paid · ${company.freeUsers.toLocaleString("en-GB")} free`,
  );
  await expect(row.getByTestId("live-loan")).toHaveText("Repaid");
  await expect(teacher.getByRole("columnheader", { name: "Income a day" }).first()).toBeVisible();
  await expect(teacher.getByRole("columnheader", { name: "Satisfaction" }).first()).toBeVisible();

  // The same summary opens from the dashboard.
  await row.getByRole("link", { name: "Reflect Ltd" }).click();
  await expect(teacher.getByTestId("summary-profit")).toHaveText(`${loss ? "−" : "+"}${money(Math.abs(api.profit))}`);
  await expect(teacher.getByTestId("income-chart")).toBeVisible();
});
