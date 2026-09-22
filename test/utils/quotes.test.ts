import { describe, expect, it, vi } from "vitest";
import { pick, QUOTES, SAD_QUOTES } from "../../src/utils/quotes";

describe("pick", () => {
  it("returns an element of the list it was handed", () => {
    expect(QUOTES).toContain(pick(QUOTES));
    expect(SAD_QUOTES).toContain(pick(SAD_QUOTES));
  });

  it("reaches the first and last item without running off either end", () => {
    // Math.random() is [0, 1), so the top of its range must land on the last
    // index rather than one past it.
    const random = vi.spyOn(Math, "random");
    try {
      random.mockReturnValue(0);
      expect(pick(["a", "b", "c"])).toBe("a");
      random.mockReturnValue(0.9999999999);
      expect(pick(["a", "b", "c"])).toBe("c");
    } finally {
      random.mockRestore();
    }
  });

  it("is not limited to strings", () => {
    expect(pick([{ id: 1 }])).toEqual({ id: 1 });
  });

  it("has something to draw from in both quote lists", () => {
    expect(QUOTES.length).toBeGreaterThan(0);
    expect(SAD_QUOTES.length).toBeGreaterThan(0);
  });
});
