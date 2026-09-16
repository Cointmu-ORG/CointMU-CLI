import { describe, expect, it } from "vitest";
import {
  checkNodeVersion,
  MIN_NODE_MAJOR,
  MIN_NODE_MINOR,
} from "../src/preflight";

describe("checkNodeVersion", () => {
  it("rejects a Node version below the minimum with a readable message", () => {
    const message = checkNodeVersion("v18.20.4");
    expect(message).toContain(`Node.js ${MIN_NODE_MAJOR}`);
    expect(message).toContain("v18.20.4");
  });

  it("accepts the minimum supported version", () => {
    expect(
      checkNodeVersion(`v${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0`),
    ).toBeNull();
  });

  it("rejects a minor below the minimum on the oldest supported major", () => {
    // process.loadEnvFile() does not exist before 20.12, so the CLI would
    // crash at startup rather than run degraded.
    const message = checkNodeVersion("v20.11.1");
    expect(message).toContain(`Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}`);
    expect(message).toContain("v20.11.1");
  });

  it("accepts a newer minor on the oldest supported major", () => {
    expect(checkNodeVersion("v20.19.0")).toBeNull();
  });

  it("does not block a version string carrying only a major", () => {
    expect(checkNodeVersion("v20")).toBeNull();
  });

  it("accepts versions newer than the minimum", () => {
    expect(checkNodeVersion("v24.1.0")).toBeNull();
  });

  it("does not block a runtime whose version string cannot be parsed", () => {
    expect(checkNodeVersion("not-a-version")).toBeNull();
  });
});
