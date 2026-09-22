import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

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

// Issue #147: the gate `cmu test` showed came from runCompile() and listed only
// cmu.config.ts, while every file in test/ then ran with a PRIVATE_KEY in its
// environment. runTest() now gates first, with the real list.
describe("runTest trust gate", () => {
  let tmpDir: string;
  let confirmProjectTrust: ReturnType<typeof vi.fn>;
  let runCompile: ReturnType<typeof vi.fn>;

  async function loadTest() {
    vi.resetModules();
    // Declining is the shortest way to stop the run at the gate; every case
    // here is about what happens up to and including it.
    confirmProjectTrust = vi
      .fn()
      .mockRejectedValue(new Error("aborted: no project code was executed"));
    runCompile = vi.fn().mockResolvedValue(undefined);
    vi.doMock("../../src/utils/trust", () => ({
      confirmProjectTrust,
      findProjectConfig: () => path.join(tmpDir, "cmu.config.ts"),
    }));
    vi.doMock("../../src/commands/compile", () => ({ runCompile }));
    vi.doMock("../../src/utils/hardhat", () => ({
      requireEdrNode: () => {},
      silenceHardhatNoise: () => {},
      bootHardhat: async () => {
        throw new Error("bootHardhat should never be reached");
      },
    }));
    return import("../../src/commands/test");
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-test-trust-"));
    fs.mkdirSync(path.join(tmpDir, "test"));
    fs.writeFileSync(path.join(tmpDir, "cmu.config.ts"), "export default {};");
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("../../src/utils/trust");
    vi.doUnmock("../../src/commands/compile");
    vi.doUnmock("../../src/utils/hardhat");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lists the config and every executable file in test/, not just the config", async () => {
    fs.writeFileSync(path.join(tmpDir, "test", "Template.test.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "test", "Second.test.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "test", "Legacy.test.js"), "");
    // mocha's glob is test/**/*, so a nested file runs too.
    fs.mkdirSync(path.join(tmpDir, "test", "unit"));
    fs.writeFileSync(path.join(tmpDir, "test", "unit", "Nested.test.ts"), "");
    // Not executed by the runner, so not part of the claim.
    fs.writeFileSync(path.join(tmpDir, "test", "fixture.json"), "{}");
    const { runTest } = await loadTest();

    await expect(runTest({ yes: true })).rejects.toThrow(/aborted/i);

    expect(confirmProjectTrust).toHaveBeenCalledWith(
      [
        path.join(tmpDir, "cmu.config.ts"),
        path.join(tmpDir, "test", "Legacy.test.js"),
        path.join(tmpDir, "test", "Second.test.ts"),
        path.join(tmpDir, "test", "Template.test.ts"),
        path.join(tmpDir, "test", "unit", "Nested.test.ts"),
      ],
      { yes: true, variant: "test" },
    );
  });

  it("asks with the test wording, not the deploy or read-only one", async () => {
    fs.writeFileSync(path.join(tmpDir, "test", "Template.test.ts"), "");
    const { runTest } = await loadTest();

    await expect(runTest({ yes: true })).rejects.toThrow(/aborted/i);

    expect(confirmProjectTrust.mock.calls[0][1]).toMatchObject({
      variant: "test",
    });
  });

  it("compiles nothing when the user declines", async () => {
    fs.writeFileSync(path.join(tmpDir, "test", "Template.test.ts"), "");
    const { runTest } = await loadTest();

    await expect(runTest()).rejects.toThrow(/aborted/i);

    // The whole point of gating before runCompile(): a declined run builds
    // nothing and executes nothing.
    expect(runCompile).not.toHaveBeenCalled();
  });

  it("stops before the gate when there is no test/ directory", async () => {
    fs.rmSync(path.join(tmpDir, "test"), { recursive: true });
    const { runTest } = await loadTest();

    await expect(runTest({ yes: true })).rejects.toThrow(/test\/ directory/);

    expect(confirmProjectTrust).not.toHaveBeenCalled();
    expect(runCompile).not.toHaveBeenCalled();
  });
});
