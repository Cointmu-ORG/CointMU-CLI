import { afterEach, describe, expect, it, vi } from "vitest";
import { maskPrivateKey, pingNetwork } from "../../src/commands/deploy";

describe("maskPrivateKey", () => {
  it("shows the first 5 and last 4 chars of a normal-length key", () => {
    // well-known Ganache test key — never fund this
    const pk =
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(maskPrivateKey(pk)).toBe("0x59c...690d");
  });

  it("fully redacts a key too short to mask meaningfully", () => {
    expect(maskPrivateKey("0x1234")).toBe("***");
  });
});

describe("pingNetwork", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reports an unreachable endpoint when the provider outlasts NETWORK_TIMEOUT_MS", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          // Never settles, so pingNetwork's internal timeout must fire.
          getNetwork() {
            return new Promise(() => {});
          }
        },
      },
    }));

    await expect(pingNetwork("http://192.0.2.1:8545")).rejects.toThrow(
      /is unreachable/,
    );
  });

  it("reports the caller's network name, not ethers' 'unknown' for chain 1912", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork() {
            // What ethers actually returns for an unregistered chain.
            return Promise.resolve({ name: "unknown", chainId: 1912n });
          }
        },
      },
    }));

    await pingNetwork("http://127.0.0.1:8585", "local");

    const output = log.mock.calls.flat().join("\n");
    expect(output).toContain("Connected to 'local' (chain ID 1912).");
    expect(output).not.toContain("unknown");
  });

  // A pending timer holds the process open: every command that pings first
  // would sit for NETWORK_TIMEOUT_MS after it is done.
  it("clears its timeout once the node answers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork() {
            return Promise.resolve({ name: "unknown", chainId: 1912n });
          }
        },
      },
    }));
    vi.useFakeTimers();
    try {
      await pingNetwork("http://127.0.0.1:8585", "local");

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to the name ethers reports when the caller passes none", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork() {
            return Promise.resolve({ name: "sepolia", chainId: 11155111n });
          }
        },
      },
    }));

    await pingNetwork("http://127.0.0.1:8585");

    expect(log.mock.calls.flat().join("\n")).toContain(
      "Connected to 'sepolia'",
    );
  });

  it("rejects an empty url without waiting out the timeout", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    // cmu.config networks are rejected earlier, by getDeployNetwork(); what
    // reaches here is a saved network, so the hint must not name a config file.
    const error = await pingNetwork("", "staging").catch((e: Error) => e);
    expect((error as Error).message).toMatch(
      /^network 'staging' has no url\.\n.*`cmu network save <url> --name staging`/,
    );
    expect((error as Error).message).not.toMatch(/cmu\.config/);
    // Never announces a ping it did not attempt.
    expect(log).not.toHaveBeenCalled();
  });
});
