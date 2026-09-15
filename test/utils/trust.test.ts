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
