import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
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

// Issue #183: `cmu test` was gated only by runCompile(), which lists the config
// with read-only wording, while every file in test/ then ran as code with a
// PRIVATE_KEY and the full environment.
describe("runTest trust gate", () => {
  // Hardhat's well-known default mnemonic; derives an unfunded devnet key.
  const MNEMONIC =
    "test test test test test test test test test test test junk";
  const realIsTTY = process.stdin.isTTY;
  let tmpDir: string;
  let everything: string[];
  let prompt: ReturnType<typeof vi.fn>;
  let runCompile: ReturnType<typeof vi.fn>;
  let bootHardhat: ReturnType<typeof vi.fn>;
  let run: ReturnType<typeof vi.fn>;

  /** Writes a file under the temp project, creating its directory. */
  function write(relative: string) {
    const file = path.join(tmpDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "throw new Error('this file must not run');");
  }

  beforeEach(() => {
    // printGasReport's suite above mocks ethers, and resetModules() clears the
    // module cache but not the mock registry; the real one derives the key.
    vi.doUnmock("ethers");
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-test-gate-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    write("cmu.config.ts");
    write("test/a.test.ts");
    write("test/nested/b.test.ts");

    everything = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        everything.push(a.map(String).join(" "));
      });
    }
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`process.exit(${code})`);
    });

    prompt = vi.fn();
    vi.doMock("inquirer", () => ({ default: { prompt } }));
    // Gates the way the real runCompile() does, so the per-process memo
    // between the two gates is exercised rather than stubbed away.
    runCompile = vi.fn(async (options: { yes?: boolean }) => {
      const trust = await import("../../src/utils/trust");
      await trust.confirmProjectTrust([trust.findProjectConfig()], {
        yes: options.yes,
        variant: "readOnly",
      });
    });
    vi.doMock("../../src/commands/compile", () => ({ runCompile }));
    bootHardhat = vi.fn(async () => ({
      hre: { network: { create: async () => ({ provider: {} }) } },
      mnemonic: MNEMONIC,
      override: {},
    }));
    vi.doMock("../../src/utils/hardhat", () => ({
      bootHardhat,
      requireEdrNode: () => {},
      silenceHardhatNoise: () => {},
    }));
    vi.doMock("../../src/utils/rpcProxy", () => ({
      startRpcProxy: async () => ({ close: (done: () => void) => done() }),
    }));
    run = vi.fn(async () => {});
    vi.doMock("../../src/utils/exec", () => ({ run }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const mod of [
      "inquirer",
      "../../src/commands/compile",
      "../../src/utils/hardhat",
      "../../src/utils/rpcProxy",
      "../../src/utils/exec",
    ]) {
      vi.doUnmock(mod);
    }
    vi.resetModules();
    process.stdin.isTTY = realIsTTY;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Asserts that nothing past the gate ran. */
  function expectNothingRan() {
    expect(runCompile).not.toHaveBeenCalled();
    expect(bootHardhat).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  }

  it("lists the config and every test file, with the test wording", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: false });
    const { runTest } = await import("../../src/commands/test");

    await expect(runTest()).rejects.toThrow(/aborted/);

    const output = everything.join("\n");
    expect(output).toContain(path.join(tmpDir, "cmu.config.ts"));
    expect(output).toContain(path.join(tmpDir, "test", "a.test.ts"));
    expect(output).toContain(path.join(tmpDir, "test", "nested", "b.test.ts"));
    expect(output).toContain(".env");
    expect(output).toContain("PRIVATE_KEY for a devnet account");
    expect(output).not.toContain("does not sign anything");
    expect(output).not.toContain("does not unlock");
    expect(output).not.toContain("Compiling contracts...");
    expect(prompt).toHaveBeenCalledOnce();
    expectNothingRan();
  });

  it("runs nothing when the prompt is cancelled with Ctrl-C", async () => {
    process.stdin.isTTY = true;
    prompt.mockRejectedValue(
      Object.assign(new Error("User force closed the prompt"), {
        name: "ExitPromptError",
      }),
    );
    const { runTest } = await import("../../src/commands/test");

    await expect(runTest()).rejects.toThrow(/force closed/);
    expectNothingRan();
  });

  it("refuses in a non-interactive session without --yes", async () => {
    process.stdin.isTTY = false;
    const { runTest } = await import("../../src/commands/test");

    await expect(runTest()).rejects.toThrow(/non-interactive session/);
    expect(prompt).not.toHaveBeenCalled();
    expectNothingRan();
  });

  it("continues with --yes and hands the suite a devnet key", async () => {
    process.stdin.isTTY = false;
    const { runTest } = await import("../../src/commands/test");

    await runTest({ yes: true });

    expect(prompt).not.toHaveBeenCalled();
    expect(runCompile).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
    const [, args, opts] = run.mock.calls[0];
    expect(args).toContain("test/**/*.ts");
    expect(opts.env.PRIVATE_KEY).toMatch(/^0x[0-9a-f]{64}$/);
  });

  // The memo is a boolean: whichever gate fires first silences the rest. This
  // gate has to come before runCompile()'s config-only, read-only one.
  it("asks once, before compiling, with the list that includes test/", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { runTest } = await import("../../src/commands/test");

    await runTest();

    const output = everything.join("\n");
    expect(prompt).toHaveBeenCalledOnce();
    expect(output).toContain(path.join(tmpDir, "test", "a.test.ts"));
    expect(output).not.toContain("does not sign anything");
    expect(output.indexOf("warning:")).toBeLessThan(
      output.indexOf("Compiling contracts..."),
    );
    expect(runCompile).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledOnce();
  });

  it("lists only the extension mocha will run", async () => {
    fs.rmSync(path.join(tmpDir, "test"), { recursive: true });
    write("test/a.test.js");
    write("test/nested/b.test.js");
    write("test/nested/c.test.ts");
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { runTest } = await import("../../src/commands/test");

    await runTest();

    const output = everything.join("\n");
    expect(output).toContain(path.join(tmpDir, "test", "a.test.js"));
    expect(output).toContain(path.join(tmpDir, "test", "nested", "b.test.js"));
    expect(output).not.toContain("c.test.ts");
    expect(run.mock.calls[0][1]).toEqual(["mocha", "test/**/*.js"]);
  });
});
