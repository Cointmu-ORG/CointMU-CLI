import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

const SCRIPT = "/tmp/project/deploy/00_deploy.ts";

/**
 * Loads a fresh copy of the module so the per-process confirmation memo and any
 * inquirer mock are isolated per test.
 */
async function loadTrust() {
  vi.resetModules();
  return import("../../src/utils/trust");
}

describe("confirmProjectTrust", () => {
  let prompt: ReturnType<typeof vi.fn>;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    prompt = vi.fn();
    vi.doMock("inquirer", () => ({ default: { prompt } }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("inquirer");
    vi.resetModules();
    process.stdin.isTTY = realIsTTY;
  });

  it("lists every file that is about to be executed", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust([SCRIPT, "/tmp/project/cmu.config.ts"]);

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain(SCRIPT);
    expect(output).toContain("/tmp/project/cmu.config.ts");
    expect(output).toContain("PRIVATE_KEY");
    expect(prompt).toHaveBeenCalledOnce();
  });

  // Frozen verbatim: `deploy` and `console` really do inject a decrypted
  // PRIVATE_KEY, and this is the wording that says so. Issue #137 changed only
  // the read-only variant below, so a diff here means a regression there.
  it("prints the key-injection wording unchanged for deploy and console", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust([SCRIPT]);

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain(
      "\n    They run with your full environment, including the PRIVATE_KEY decrypted from\n" +
        "    your session and injected for deploy scripts, and can do anything your user\n" +
        "    account can. This is the same trust model as Hardhat, Foundry and Truffle;\n" +
        "    see the 'Trust Model' section of the README.\n",
    );
  });

  it("claims no key injection for read-only callers (compile, explorer)", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust(["/tmp/project/cmu.config.ts"], {
      variant: "readOnly",
    });

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain("/tmp/project/cmu.config.ts");
    expect(output).not.toContain("PRIVATE_KEY");
    // Frozen verbatim: issue #183 added a variant for `test` and must not have
    // touched what `compile` and `explorer` print.
    expect(output).toContain(
      "\n    They are require()d as code to read this project's configuration, run with\n" +
        "    your full environment, and can do anything your user account can. This\n" +
        "    command does not sign anything and does not unlock your session. This is the\n" +
        "    same trust model as Hardhat, Foundry and Truffle; see the 'Trust Model'\n" +
        "    section of the README.\n",
    );
    // Still a real gate, whatever the wording.
    expect(prompt).toHaveBeenCalledOnce();
  });

  // Issue #183: `cmu test` used to inherit the read-only wording from
  // runCompile() while its suite ran with a PRIVATE_KEY and the full env.
  it("tells test callers about the environment and the devnet key", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust(["/tmp/project/test/Token.test.ts"], {
      variant: "test",
    });

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain(
      "\n    They run with your full environment, including anything set in .env or your\n" +
        "    shell, and can do anything your user account can. The test files also get a\n" +
        "    PRIVATE_KEY for a devnet account derived from the devnet mnemonic. This is\n" +
        "    the same trust model as Hardhat, Foundry and Truffle; see the 'Trust Model'\n" +
        "    section of the README.\n",
    );
    expect(output).not.toContain("does not sign anything");
    expect(output).not.toContain("decrypted from");
  });

  it("names the first 20 files and counts the rest", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();
    const files = Array.from(
      { length: 25 },
      (_, i) => `/tmp/project/test/s${String(i).padStart(2, "0")}.test.ts`,
    );

    await confirmProjectTrust(files, { variant: "test" });

    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain(files[19]);
    expect(output).not.toContain(files[20]);
    expect(output).toContain("...and 5 more");
  });

  it("aborts without executing anything when the user declines", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: false });
    const { confirmProjectTrust } = await loadTrust();

    await expect(confirmProjectTrust([SCRIPT])).rejects.toThrow(/aborted/i);
  });

  it("skips the prompt entirely when --yes is passed", async () => {
    process.stdin.isTTY = true;
    const { confirmProjectTrust } = await loadTrust();

    await expect(
      confirmProjectTrust([SCRIPT], { yes: true }),
    ).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("blocks with a clear error in a non-TTY session instead of hanging", async () => {
    process.stdin.isTTY = false;
    const { confirmProjectTrust } = await loadTrust();

    await expect(confirmProjectTrust([SCRIPT])).rejects.toThrow(
      /non-interactive session[\s\S]*--yes/,
    );
    // Never falls through to a prompt no one can answer.
    expect(prompt).not.toHaveBeenCalled();
  });

  it("still honours --yes in a non-TTY session", async () => {
    process.stdin.isTTY = false;
    const { confirmProjectTrust } = await loadTrust();

    await expect(
      confirmProjectTrust([SCRIPT], { yes: true }),
    ).resolves.toBeUndefined();
  });

  it("asks only once per process (deploy gates, then runCompile gates again)", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust([SCRIPT]);
    await confirmProjectTrust(["/tmp/project/cmu.config.ts"]);

    expect(prompt).toHaveBeenCalledOnce();
  });

  it("does not prompt when there is nothing to execute", async () => {
    process.stdin.isTTY = true;
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust([]);
    expect(prompt).not.toHaveBeenCalled();
  });

  // console, explorer and deploy pass findProjectConfig() straight in.
  it("skips a null target, the result of finding no config", async () => {
    process.stdin.isTTY = true;
    prompt.mockResolvedValue({ proceed: true });
    const { confirmProjectTrust } = await loadTrust();

    await confirmProjectTrust([null]);
    expect(prompt).not.toHaveBeenCalled();

    await confirmProjectTrust([null, SCRIPT]);
    const output = (console.log as any).mock.calls.flat().join("\n");
    expect(output).toContain(SCRIPT);
    expect(output).not.toContain("null");
    expect(prompt).toHaveBeenCalledOnce();
  });
});

describe("findProjectConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-trust-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the project has no config", async () => {
    const { findProjectConfig } = await loadTrust();
    expect(findProjectConfig(tmpDir)).toBeNull();
  });

  it("prefers cmu.config.ts over cmu.config.js", async () => {
    fs.writeFileSync(path.join(tmpDir, "cmu.config.js"), "");
    fs.writeFileSync(path.join(tmpDir, "cmu.config.ts"), "");
    const { findProjectConfig } = await loadTrust();
    expect(findProjectConfig(tmpDir)).toBe(path.join(tmpDir, "cmu.config.ts"));
  });
});
