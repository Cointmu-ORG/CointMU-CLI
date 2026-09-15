import { describe, expect, it } from "vitest";
import { checkNodeVersion, MIN_NODE_MAJOR } from "../src/preflight";

describe("checkNodeVersion", () => {
  it("rejects a Node version below the minimum with a readable message", () => {
    const message = checkNodeVersion("v18.20.4");
    expect(message).toContain(`Node.js ${MIN_NODE_MAJOR}`);
    expect(message).toContain("v18.20.4");
  });

  it("accepts the minimum supported version", () => {
    expect(checkNodeVersion("v20.0.0")).toBeNull();
  });

  it("accepts versions newer than the minimum", () => {
    expect(checkNodeVersion("v24.1.0")).toBeNull();
  });

  it("does not block a runtime whose version string cannot be parsed", () => {
    expect(checkNodeVersion("not-a-version")).toBeNull();
  });
});
