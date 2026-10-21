import { expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Creates a login code from a signed-in staff page and returns it. The code comes from the server's reply, not the
 * table's first row: the table already lists codes from earlier tests, and until the new row lands its first row is
 * one of those, whose companies would then show up in this test.
 */
export async function createCode(teacher: Page) {
  const [response] = await Promise.all([
    teacher.waitForResponse(
      (r) => r.request().method() === "POST" && new URL(r.url()).pathname === "/api/teacher/codes",
    ),
    teacher.getByRole("button", { name: "Create code" }).click(),
  ]);
  expect(response.ok()).toBe(true);
  const { code } = (await response.json()) as { code: string };
  await expect(teacher.locator(`td[data-code="${code}"]`)).toBeVisible();
  return code;
}

/**
 * A first setup for each model, the one round two gave a new company before launch day: a medium app server and
 * database on IaaS, large ones on-prem, one app instance and a small managed database on PaaS, nothing on SaaS.
 */
const FIRST_SETUP: Record<string, object[]> = {
  onprem: [
    { type: "buyServer", server: "app", size: "large" },
    { type: "buyServer", server: "database", size: "large" },
  ],
  iaas: [
    { type: "rentServer", server: "app", size: "medium" },
    { type: "rentServer", server: "database", size: "medium" },
  ],
  paas: [
    { type: "setInstances", count: 1 },
    { type: "setManagedService", service: "database", size: "small" },
  ],
  saas: [],
};

/**
 * Sets up a company's first servers through the API, as a student would on day 1, then plays on to its launch: the end
 * of day 3, or on-prem when its kit arrives. Returns the company then.
 */
export async function launch(request: APIRequestContext, code: string, id: string, model: string) {
  const url = `/api/codes/${code}/companies/${id}`;
  for (const action of FIRST_SETUP[model]!) expect((await request.post(`${url}/actions`, { data: action })).ok()).toBe(true);
  for (;;) {
    const res = await request.post(`${url}/continue`);
    expect(res.ok()).toBe(true);
    const { company } = await res.json();
    if (company.launch.status === "launched") return company;
  }
}
