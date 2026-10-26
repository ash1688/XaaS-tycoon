import { expect, test, type Page } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";

// The C-suite (#108) on its own page: the heads open from day 1 with shortlists, the rest say when they open, Hire
// hires at once and for good, the executive's pay and shares show, the board's pay holiday is explained, and the IPO
// needs every role filled.

let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = null;
});

const nav = (page: Page) => page.getByRole("navigation", { name: "Game" });
const goTo = (page: Page, name: string) => nav(page).getByRole("link", { name, exact: true }).click();

test("hires a head of development from the shortlist, for good, and the IPO checklist counts them towards the full C-suite", async ({
  browser,
  request,
}) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}`);
  await student.getByText("Social network").click();
  await student.locator("label.choice", { hasText: "Build on a SaaS platform (SaaS)" }).click();
  await student.getByLabel("Company name").fill("Leaders Ltd");
  await student.getByRole("button", { name: "Start company" }).click();
  await expect(student.getByTestId("day")).toHaveText(/^1 of/);

  await goTo(student, "C-suite");
  const csuite = student.getByTestId("csuite");
  await expect(csuite.getByRole("heading", { name: "C-suite" })).toBeVisible();
  await expect(csuite).toContainText("10% left");
  // Shut roles say when they open; the IPO needs every role.
  await expect(csuite.getByTestId("csuite-cfo")).toContainText("Opens once you take outside money");
  await expect(csuite.getByTestId("csuite-ipo")).toContainText("Every role must be filled to float: 0 of 11 hired");
  await expect(csuite.getByTestId("csuite-pay-holiday-rule")).toContainText(
    "If cash falls below 7 days of running costs, the board forgoes its pay until there are 21 days' worth in the bank.",
  );
  await expect(csuite.getByTestId("csuite-legalCounsel")).toContainText("Opens when Series A venture capitalists approach");

  const dev = csuite.getByTestId("csuite-headOfDevelopment");
  const candidate = dev.getByTestId("candidate-headOfDevelopment-1");
  await expect(dev.locator("tbody tr")).toHaveCount(3);
  await expect(candidate).toContainText("developer output");
  const name = (await candidate.locator("th").textContent())!.trim();
  await candidate.getByTestId("hire-executive").click();
  await expect(dev.getByTestId("csuite-executive")).toContainText(`${name}, hired on day 1`);
  await expect(dev.locator("tbody tr")).toHaveCount(0);
  await expect(csuite.getByTestId("csuite-pay")).toContainText("a day");

  await goTo(student, "Finance");
  await expect(student.getByTestId("cap-executive")).toContainText(`${name} (Head of development)`);
  // One of the 11 hired: the IPO's full C-suite line counts it, still short.
  await expect(student.getByTestId("ipo-csuite")).toHaveAttribute("data-met", "false");
  await expect(student.getByTestId("ipo-csuite")).toContainText("1 of 11 hired");
});
