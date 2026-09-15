import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { printWelcomeBanner } from "../../src/commands/create";

describe("printWelcomeBanner", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function output(): string {
    return (console.log as any).mock.calls.flat().join("\n");
  }

  it("names the project and the commands that come next", () => {
    printWelcomeBanner("my-dapp", "a quote");

    expect(output()).toContain("Created");
    expect(output()).toContain("my-dapp");
    expect(output()).toContain("Next steps:");
    expect(output()).toContain("cd my-dapp");
    expect(output()).toContain("cmu compile");
    expect(output()).toContain("cmu deploy");
  });

  it("signs off with the quote it was handed, not one of its own", () => {
    printWelcomeBanner("my-dapp", "chosen by the caller");

    expect(output()).toContain("chosen by the caller");
  });

  it("closes every colour escape it opens", () => {
    printWelcomeBanner("my-dapp", "a quote");

    // Counted by splitting rather than matching: a regex holding the escape
    // byte trips eslint's no-control-regex.
    const text = output();
    const count = (needle: string) => text.split(needle).length - 1;
    const ESC = "\u001b[";
    const opened = count(`${ESC}1m`) + count(`${ESC}32m`) + count(`${ESC}36m`);
    expect(count(`${ESC}0m`)).toBe(opened);
  });
});
