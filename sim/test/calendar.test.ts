import { describe, expect, it } from "vitest";
import { createSim, dayOfDate, defaultConfig, gameDate, SimError, type GameConfig, type GameState } from "../src/index.ts";

// The real calendar and its holidays, through the sim's public interface, on the default config. Events are taken out
// so only holidays move load and growth.
const quiet: GameConfig = { ...defaultConfig, events: [], allowedGameLengths: { "180-days": 1, "1-year": 1, career: 1 } };
const sim = createSim(quiet);

const begin = (productType: string, startDate: string, gameLength = "1-year") =>
  sim.newGame({ companyName: "Acme", productType, model: "saas", seed: 7, startDate, gameLength });

/** Plays a game until the day just played is the one on a date. */
const playTo = (state: GameState, iso: string) => sim.advance(state, dayOfDate(state, iso) - state.day);

describe("the real calendar", () => {
  it("starts each game on a random date in the year, the same for a seed", () => {
    const dates = Array.from({ length: 40 }, (_, seed) =>
      sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed }).startDate,
    );
    expect(new Set(dates).size).toBeGreaterThan(30);
    expect(dates.every((d) => d.startsWith(`${defaultConfig.calendar.startYear}-`))).toBe(true);
    // Spread over the year, not bunched at its start.
    expect(new Set(dates.map((d) => d.slice(5, 7))).size).toBeGreaterThan(8);
    const again = sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3 }).startDate;
    expect(again).toBe(dates[3]);
  });

  it("starts in the year asked for, or on the date asked for", () => {
    const state = sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3, startYear: 2031 });
    expect(state.startDate.slice(0, 4)).toBe("2031");
    expect(begin("social", "2026-02-28").startDate).toBe("2026-02-28");
    expect(() => begin("social", "2026-02-30")).toThrow(SimError);
    expect(() => sim.newGame({ companyName: "Acme", productType: "social", model: "saas", seed: 3, startYear: 1.5 })).toThrow(
      SimError,
    );
  });

  it("counts real dates and years forward from the start date", () => {
    const state = begin("social", "2026-12-30");
    expect(sim.calendar(state).today).toMatchObject({ iso: "2026-12-30", year: 2026, text: "Wednesday 30 December 2026" });
    const later = sim.advance(state, 3).state;
    expect(sim.calendar(later).today).toMatchObject({ iso: "2027-01-02", year: 2027, month: 1, dayOfMonth: 2 });
    expect(sim.calendar(later).startYear).toBe(2026);
    // A career runs decades: day 1 + 47 × 365 days is 47 years on, less the leap days.
    const career = begin("social", "2026-06-01", "career");
    expect(gameDate(career, career.finalDay).year).toBe(2073);
    expect(dayOfDate(career, "2026-06-01")).toBe(1);
  });

  it("puts each holiday on its real dates every year: Easter and Black Friday move", () => {
    const state = begin("social", "2026-01-01", "career");
    const dates = (id: string, year: number) => {
      // The next run after the day before the year starts.
      const before = { ...state, day: dayOfDate(state, `${year}-01-01`) - 1 };
      const h = sim.calendar(before).upcoming.find((u) => u.id === id)!;
      return [h.start.iso, h.end.iso];
    };
    // Black Friday is the day after the fourth Thursday in November, to Cyber Monday.
    expect(dates("blackFriday", 2026)).toEqual(["2026-11-27", "2026-11-30"]);
    expect(dates("blackFriday", 2027)).toEqual(["2027-11-26", "2027-11-29"]);
    // Easter Sunday is 5 April 2026 and 28 March 2027: the holidays start 9 days before it.
    expect(dates("easter", 2026)[0]).toBe("2026-03-27");
    expect(dates("easter", 2027)[0]).toBe("2027-03-19");
    expect(dates("christmas", 2026)).toEqual(["2026-12-18", "2027-01-01"]);
    expect(dates("summer", 2030)).toEqual(["2030-07-22", "2030-09-01"]);
  });
});

describe("holidays", () => {
  it("gives a shop its Black Friday spike in load and sign-ups, every year", () => {
    // The Thursdays before Black Friday.
    for (const thursday of ["2026-11-26", "2027-11-25"]) {
      const shop = playTo(begin("ecommerce", `${thursday.slice(0, 4)}-10-01`), thursday).state;
      const { effect } = sim.calendar(shop).upcoming.find((h) => h.id === "blackFriday")!;
      expect(effect!.loadMultiplier).toBeGreaterThan(2);
      const friday = sim.advance(shop, 1);
      expect(sim.calendar(friday.state).on.map((h) => h.id)).toEqual(["blackFriday"]);
      // Load per user more than doubles on the day.
      const perUser = (s: GameState) => s.load / s.users;
      expect(perUser(friday.state) / perUser(shop)).toBeGreaterThan(1.8);
      expect(friday.log[0]!.entries.some((e) => e.kind === "calendar" && e.text.startsWith("Black Friday starts today"))).toBe(true);
    }
  });

  it("makes each product feel a holiday its own way", () => {
    // Over the summer holidays social and video are busier; a shop doesn't notice.
    const ratio = (productType: string) => {
      const before = playTo(begin(productType, "2026-07-01"), "2026-07-21").state;
      const during = sim.advance(before, 1).state;
      return during.load / during.users / (before.load / before.users);
    };
    expect(ratio("social")).toBeGreaterThan(1.15);
    expect(ratio("video")).toBeGreaterThan(1.2);
    expect(ratio("ecommerce")).toBeLessThan(1.12);
    const shop = playTo(begin("ecommerce", "2026-07-01"), "2026-07-25").state;
    expect(sim.calendar(shop).on.map((h) => [h.id, h.effect])).toEqual([["summer", null]]);
  });

  it("speeds or slows growth on its days: a shop grows more slowly in the January blues", () => {
    const grown = (startDate: string) => {
      const start = playTo(begin("ecommerce", startDate), new Date(Date.parse(startDate) + 9 * 864e5).toISOString().slice(0, 10)).state;
      return sim.advance(start, 20).state.users / start.users;
    };
    // The same 20 days of the year, in January and then in March.
    expect(grown("2027-01-01")).toBeLessThan(grown("2026-03-01"));
  });

  it("shows the next holidays ahead of time, and announces one that hits the product before it starts", () => {
    const state = begin("ecommerce", "2026-10-01");
    const { upcoming } = sim.calendar(state);
    expect(upcoming.map((h) => h.id)).toEqual(["blackFriday", "christmas", "januaryBlues", "easter", "summer"]);
    expect(upcoming[0]).toMatchObject({ daysUntil: dayOfDate(state, "2026-11-27") - 1, startDay: 58, days: 4 });
    const notice = dayOfDate(state, "2026-11-27") - defaultConfig.calendar.noticeDays;
    const { log } = sim.advance(state, notice - 1);
    const announced = log.at(-1)!.entries.find((e) => e.kind === "calendar");
    expect(announced?.text).toMatch(/^Black Friday is coming in 14 days, on Friday 27 November 2026/);
    // A holiday the product doesn't notice isn't announced.
    const all = log.flatMap((d) => d.entries).filter((e) => e.kind === "calendar");
    expect(all.every((e) => !e.text.includes("Summer") && !e.text.includes("Easter"))).toBe(true);
  });

  it("only shows holidays that fall before the game ends", () => {
    const short = begin("social", "2026-01-05", "180-days");
    expect(sim.calendar(short).upcoming.map((h) => h.id)).toEqual(["easter"]);
    expect(sim.calendar(short).on.map((h) => h.id)).toEqual(["januaryBlues"]);
  });

  it("sits outside the encounter system: holidays don't move the danger meter", () => {
    const at = (startDate: string) => playTo(begin("ecommerce", startDate), "2026-12-01").state.dangerMeter;
    // The same number of days played, with and without Black Friday in them.
    const blackFriday = playTo(begin("ecommerce", "2026-10-02"), "2026-11-30").state;
    const ordinary = playTo(begin("ecommerce", "2026-05-02"), "2026-06-30").state;
    expect(blackFriday.day).toBe(ordinary.day);
    expect(blackFriday.dangerMeter).toBe(ordinary.dangerMeter);
    expect(blackFriday.schedule).toEqual([]);
    expect(at("2026-10-02")).toBeGreaterThan(0);
  });
});
