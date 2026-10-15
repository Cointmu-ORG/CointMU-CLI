import { describe, expect, it } from "vitest";
import { formatAge } from "../../src/commands/mine/status";

const HOUR_S = 3600;
const DAY_S = 24 * HOUR_S;

// Issue #211: an old or genesis block printed "497762h ago".
describe("formatAge", () => {
  it.each([
    [-5, "0s"],
    [59, "59s"],
    [60, "1m"],
    [HOUR_S - 1, "59m"],
    [HOUR_S, "1h"],
    [DAY_S - 1, "23h"],
    [DAY_S, "1d"],
    [2 * DAY_S - 1, "1d"],
    [497798 * HOUR_S, "20741d"],
  ])("formats %i seconds as %s", (seconds, expected) => {
    expect(formatAge(seconds)).toBe(expected);
  });
});
