import { expect, test, type APIRequestContext } from "@playwright/test";
import { E2E_TEACHER_PASSWORD } from "../playwright.config.ts";
import { movedNow, pinLaunchUsers } from "./staff.ts";

// Infrastructure clarity (playtest 1): the bar with no capacity sets it and says why, what has to be ready before
// launch, the ops cut on every bar, advice that puts ops and load balancers first, and a warning before a cancel that
// would leave too little capacity while its replacement sets up.

// Each test's code, deleted after it with its games, so later tests start with an empty dashboard.
let code: string | null = null;
test.afterEach(async ({ request }) => {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  if (code) await request.delete(`/api/teacher/codes/${code}`);
  code = null;
});

/** A new social network on IaaS on a fresh code, with its API address. */
async function newCompany(request: APIRequestContext, name: string) {
  await request.post("/api/teacher/login", { data: { password: E2E_TEACHER_PASSWORD } });
  code = (await (await request.post("/api/teacher/codes")).json()).code as string;
  const created = await request.post(`/api/codes/${code}/companies`, {
    data: { name, productType: "social", model: "iaas" },
  });
  const { id } = await created.json();
  const url = `/api/codes/${code}/companies/${id}`;
  const act = async (data: object) => expect((await request.post(`${url}/actions`, { data })).ok()).toBe(true);
  const play = async () => (await (await request.post(`${url}/continue`)).json()).company;
  return { code, id, url, act, play };
}

test("with app servers but no database, the database bar sets capacity and says why", async ({ browser, request }) => {
  const { id, act, play } = await newCompany(request, "No Database Ltd");
  // An app server rented and ready, but no database.
  await act({ type: "rentServer", server: "app", size: "small" });
  await play();
  await play();
  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);

  // Before launch: what has to be ready, a cache optional.
  const needs = student.getByTestId("launch-needs");
  await expect(needs).toContainText("A cache is optional");
  await expect(needs.getByTestId("launch-need-app")).toContainText("At least one app server (done)");
  await expect(needs.getByTestId("launch-need-database")).toContainText("At least one database (to do)");

  // Nothing is served without a database, so it's the database that sets capacity, not compute.
  await expect(student.getByTestId("tier-dbu")).toContainText("Sets your capacity");
  await expect(student.getByTestId("tier-cu")).not.toContainText("Sets your capacity");
  await expect(student.getByTestId("tier-dbu-note")).toContainText("No database: you can't serve any users until one is ready.");
  await expect(student.getByTestId("tier-ch-note")).toContainText("No cache. It's optional");

  // Renting one: it says when it will be ready.
  await student.getByTestId("servers-panel").getByRole("button", { name: "Rent a small database" }).click();
  await expect(student.getByTestId("tier-dbu-note")).toContainText(/No database ready yet: .* after day \d+\./);
  await expect(needs.getByTestId("launch-need-database")).toContainText("(done)");
});

test("missing ops show on every bar and come first in the advice; then a full load balancer and a cancel are warned of", async ({
  browser,
  request,
}) => {
  const { id, act, play } = await newCompany(request, "Short Ops Ltd");
  // Enough users to fill most of a medium app server's 10 CU.
  await pinLaunchUsers(id, 7_000);
  await act({ type: "rentServer", server: "app", size: "medium" });
  await act({ type: "rentServer", server: "database", size: "medium" });
  while ((await play()).launch.status !== "launched");
  // Four more databases need a second ops person, and the company has one: every tier is cut by 30%.
  for (let i = 0; i < 4; i++) await act({ type: "rentServer", server: "database", size: "small" });
  await play();

  const student = await (await browser.newContext()).newPage();
  await student.goto(`/play/${code}/${id}/infrastructure`);
  await expect(student.getByTestId("tier-cu-cut")).toHaveText("7 of 10 CU: cut 30%, 1 ops short.");
  await expect(student.getByTestId("tier-dbu-cut")).toContainText("of 34 DBU: cut 30%, 1 ops short.");
  await expect(student.getByTestId("capacity-ops-short")).toContainText("You're 1 ops person short, so every tier is cut by 30%");
  // Hiring the ops person gets back more than another server would: the advice says so.
  await expect(student.getByTestId("tier-cu-note")).toContainText(/hire 1 ops person (soon|now), to get back the 3 CU you're losing/i);
  const servers = student.getByTestId("servers-panel");
  await expect(servers.getByTestId("tier-warning-app")).toContainText("hire 1 ops person");
  await expect(servers.getByTestId("step-note-app")).toContainText("You'd need 2 ops staff in all");

  // A developer put into ops, at once: no cut. Another app server alone would get no traffic without a load balancer.
  await movedNow(id);
  await student.reload();
  await expect(student.getByTestId("tier-cu-cut")).toHaveCount(0);
  await expect(student.getByTestId("tier-cu-note")).toContainText(/rent an app server and a load balancer/i);
  await expect(servers.getByTestId("tier-warning-app")).toContainText(/rent an app server and a load balancer/i);

  // Renting a small app server and cancelling the medium before it's ready would leave no compute: warned.
  await servers.getByTestId("size-app").selectOption("small");
  await servers.getByRole("button", { name: "Rent a small app server" }).click();
  await expect(servers.getByTestId("pending-app-small")).toBeVisible();
  await servers.getByTestId("size-app").selectOption("medium");
  await servers.getByRole("button", { name: "Cancel a medium app server" }).click();
  const cancel = student.getByRole("dialog", { name: "Cancel a VM" });
  await expect(cancel.getByTestId("cancel-warning")).toContainText(
    /Compute would have no capacity until your new small app server is ready, after day \d+: expect outages\./,
  );
  await cancel.getByRole("button", { name: "Keep it" }).click();
});
