import { describe, expect, it } from "vitest";
import { isNameAllowed } from "../src/index.ts";

// "Arse" is on the list: mild, but enough to test with.
describe("isNameAllowed", () => {
  it("allows ordinary company names", () => {
    for (const name of ["Acme", "Cloud 9 Hosting", "Byte-Size Ltd", "R2D2 Robotics", "Café Express", "A B C Media"]) {
      expect(isNameAllowed(name), name).toBe(true);
    }
  });

  it("rejects a listed word", () => {
    expect(isNameAllowed("Arse")).toBe(false);
    expect(isNameAllowed("Big Arse Ltd")).toBe(false);
    expect(isNameAllowed("Arses")).toBe(false);
  });

  it("sees through case, spacing, punctuation and leetspeak", () => {
    for (const name of ["ARSE", "aRsE Hosting", "A R S E", "a.r.s.e", "a-r-s-e ltd", "4r53", "@rse", "＠rse", "ar$e", "árse"]) {
      expect(isNameAllowed(name), name).toBe(false);
    }
  });

  it("reads 1 as either i or l", () => {
    expect(isNameAllowed("p1ss")).toBe(false);
    expect(isNameAllowed("1amp Co")).toBe(true);
  });

  it("allows ordinary words that contain a listed word", () => {
    for (const name of ["Scunthorpe", "class", "Assessment Co", "Essex", "Cocktail Bar", "Arsenal", "Parse", "Scrap Metal", "Title"]) {
      expect(isNameAllowed(name), name).toBe(true);
    }
  });
});
