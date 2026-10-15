import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { PASSWORD, PRIVATE_KEY, makeSession } from "../helpers/sessionEnv";

// #233: without a terminal, inquirer cannot read the session password. An
// open stdin pipe hung `cmu deploy --yes` and `cmu console --yes` forever.

const ADDRESS = new ethers.Wallet(PRIVATE_KEY).address;
const NON_INTERACTIVE =
  "cannot prompt for the session password in a non-interactive session.\n" +
  "\x1b[2mhint:\x1b[0m run this in a terminal, or set PRIVATE_KEY.";

describe("the session password prompt without a terminal", () => {
  let tmpDir: string;
  let printed: string[];
  const prompt = vi.fn();
  const prevKey = process.env.PRIVATE_KEY;
  // Usually absent under vitest rather than false; put back exactly as found.
  const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-noninteractive-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // Never reset during a test, so the leak check sees everything printed.
    printed = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        printed.push(a.map(String).join(" "));
      });
    }
    prompt
      .mockReset()
      .mockRejectedValue(new Error("inquirer.prompt should not be called"));
    vi.doMock("inquirer", () => ({ default: { prompt } }));
    delete process.env.PRIVATE_KEY;
    process.stdin.isTTY = false;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("inquirer");
    vi.resetModules();
    if (realIsTTY) Object.defineProperty(process.stdin, "isTTY", realIsTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function writeLockedSession(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify(makeSession({ address: ADDRESS })),
    );
  }

  function writeConfig(): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  // Imported after doMock, so the module's own import("inquirer") is the mock.
  async function resolvePrivateKey(options?: { prompt?: boolean }) {
    const session = await import("../../src/utils/session");
    return session.resolvePrivateKey(options);
  }

  async function getDeployNetwork() {
    const network = await import("../../src/utils/network");
    return network.getDeployNetwork("local");
  }

  async function errorOf(run: () => Promise<unknown>): Promise<Error> {
    const error = await run().then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }

  it("refuses instead of prompting for a locked session", async () => {
    writeLockedSession();

    const error = await errorOf(() => resolvePrivateKey());

    expect(error.message).toBe(NON_INTERACTIVE);
    expect(prompt).not.toHaveBeenCalled();
  });

  // One case per call site in getDeployNetwork(): `cmu deploy` and
  // `cmu console` both reach the prompt through one of the two.
  it.each([
    ["without a project config", () => {}],
    ["with a cmu.config.js that carries no key", writeConfig],
  ])("refuses through getDeployNetwork %s", async (_, setUpProject) => {
    setUpProject();
    writeLockedSession();

    const error = await errorOf(getDeployNetwork);

    expect(error.message).toBe(NON_INTERACTIVE);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("still takes PRIVATE_KEY from the environment, as CI does", async () => {
    writeLockedSession();
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    await expect(resolvePrivateKey()).resolves.toBe(PRIVATE_KEY);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("stays quiet when the caller asked for no prompt", async () => {
    writeLockedSession();

    await expect(resolvePrivateKey({ prompt: false })).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("has nothing to ask for without a session", async () => {
    await expect(resolvePrivateKey()).resolves.toBeUndefined();
    expect(prompt).not.toHaveBeenCalled();
  });

  it("names no key, password or address in what it prints or throws", async () => {
    writeLockedSession();
    const errors = [
      await errorOf(() => resolvePrivateKey()),
      await errorOf(getDeployNetwork),
    ].map((error) => error.message);

    const haystack = [...printed, ...errors].join("\n").toLowerCase();
    const secrets = [PRIVATE_KEY, ADDRESS].flatMap((hex) => [
      hex.toLowerCase(),
      hex.slice(2).toLowerCase(),
    ]);
    secrets.push(PASSWORD.toLowerCase());
    for (const secret of secrets) {
      expect(haystack).not.toContain(secret);
    }
  });
});
