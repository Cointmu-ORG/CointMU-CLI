import { afterEach, describe, expect, it, vi } from "vitest";

// The RPC proxy and its gate moved to src/utils/rpcProxy.ts, shared with
// `cmu node start`; their tests live in test/utils/rpcProxy.test.ts.

describe("printGasReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("totals the gas of every receipt it finds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getBlockNumber = async () => 1;
          getBlock = async () => ({ transactions: ["0xdead", "0xbeef"] });
          getTransactionReceipt = async () => ({ gasUsed: 21000n });
        },
      },
    }));
    const { printGasReport: report } = await import("../../src/commands/test");

    await report(8555);

    const output = (log as any).mock.calls.flat().join("\n");
    expect(output).toContain("Gas profile");
    expect(output).toContain("0xdead");
    expect(output).toContain("Total gas used: 42000");
  });

  it("downgrades its own failure to a warning so the test result stands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getBlockNumber = async () => {
            throw new Error("devnet already gone");
          };
        },
      },
    }));
    const { printGasReport: report } = await import("../../src/commands/test");

    await expect(report(8555)).resolves.toBeUndefined();

    const output = (error as any).mock.calls.flat().join("\n");
    expect(output).toContain("warning:");
    expect(output).toContain("could not produce the gas report");
  });
});
