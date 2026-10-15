import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { encryptSessionKey } from "../../src/utils/session";
import { TEST_PBKDF2_ITERATIONS } from "../helpers/testPbkdf2";
import {
  PRIVATE_KEY,
  SESSION_PASSWORD,
  expectNoKeyLeak,
} from "../helpers/consoleEnv";

describe("resolveConsoleContext", () => {
  let tmpDir: string;
  let out: string[];
  const prevKey = process.env.PRIVATE_KEY;
  const realIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    // trust.ts remembers a confirmation per process; a fresh module per test
    // keeps one test's --yes from skipping the next test's prompt.
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-ctx-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    out = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.doUnmock("inquirer");
    vi.doUnmock("crypto");
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.stdin.isTTY = realIsTTY;
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function writeConfig(prelude = ""): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `${prelude}module.exports = { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  function writeSessionFile(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        activeNetwork: "local",
        ...encryptSessionKey(
          SESSION_PASSWORD,
          PRIVATE_KEY,
          TEST_PBKDF2_ITERATIONS,
        ),
      }),
    );
  }

  async function resolve(options = {}) {
    const { resolveConsoleContext } =
      await import("../../src/commands/console");
    return resolveConsoleContext(options);
  }

  it("starts read-only when no key is available anywhere", async () => {
    const ctx = await resolve();

    expect(ctx.signer).toBeUndefined();
    expect(ctx.network.name).toBe("local");
    expect(ctx.network.url).toBe("http://127.0.0.1:8585");
    ctx.provider.destroy();
  });

  it("connects a signer from the PRIVATE_KEY env var", async () => {
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve();

    expect(ctx.signer?.address).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(ctx.signer?.provider).toBe(ctx.provider);
    ctx.provider.destroy();
  });

  it("skips the session password prompt with --no-signer", async () => {
    writeSessionFile();
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));

    // Resolving (instead of throwing from the mocked prompt) proves no prompt.
    const ctx = await resolve({ signer: false });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  // The prompt is only one of the ways a key gets in. --no-signer promises a
  // read-only console, so a key already sitting in the environment (or in
  // wallet.privateKey) must not be turned into a signer either.
  it("stays read-only with --no-signer when PRIVATE_KEY is set", async () => {
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ signer: false });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  it("stays read-only with --no-signer when the config carries a key", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { defaultNetwork: "local", ` +
        `wallet: { privateKey: ${JSON.stringify(PRIVATE_KEY)} }, ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );

    const ctx = await resolve({ signer: false, yes: true });

    expect(ctx.signer).toBeUndefined();
    ctx.provider.destroy();
  });

  it("refuses to start on a key it cannot use", async () => {
    process.env.PRIVATE_KEY = "0xnotakey";

    await expect(resolve()).rejects.toThrow(/invalid private key/);
  });

  // cmu.config.js is require()d to resolve the network, i.e. arbitrary code
  // execution from the project directory. It must not run before the user has
  // confirmed, exactly as in `cmu compile`.
  it("blocks in a non-TTY session and never loads the config", async () => {
    const marker = path.join(tmpDir, "executed.txt");
    writeConfig(
      `require("fs").writeFileSync(${JSON.stringify(marker)}, "x");\n`,
    );
    process.stdin.isTTY = false;

    await expect(resolve()).rejects.toThrow(/non-interactive session/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("fails before the REPL on a network the config does not define", async () => {
    writeConfig();

    await expect(resolve({ network: "mars", yes: true })).rejects.toThrow(
      /is not defined/,
    );
  });

  // Issue #185: --no-signer decrypts nothing, so its trust prompt must not
  // claim a key decrypted from the session; without the flag it still must.
  it("prints the read-only trust wording with --no-signer", async () => {
    writeConfig();
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ signer: false, yes: true });
    ctx.provider.destroy();

    const prompt = out.join("\n");
    expect(prompt).toContain("does not unlock your session");
    expect(prompt).not.toContain("decrypted from");
    expectNoKeyLeak(out, tmpDir);
  });

  it("keeps the key-decryption trust wording without --no-signer", async () => {
    writeConfig();
    process.env.PRIVATE_KEY = PRIVATE_KEY;

    const ctx = await resolve({ yes: true });
    ctx.provider.destroy();

    expect(out.join("\n")).toContain("decrypted from\n    your session");
    expectNoKeyLeak(out, tmpDir);
  });

  /** Passes node's crypto through, counting the calls a decryption makes. */
  function spyOnDecryption() {
    const spies = { pbkdf2Sync: vi.fn(), createDecipheriv: vi.fn() };
    vi.doMock("crypto", async (importOriginal) => {
      const real = await importOriginal<typeof import("crypto")>();
      const wrapped = {
        ...real,
        pbkdf2Sync: spies.pbkdf2Sync.mockImplementation(real.pbkdf2Sync),
        createDecipheriv: spies.createDecipheriv.mockImplementation(
          real.createDecipheriv,
        ),
      };
      return { ...wrapped, default: wrapped };
    });
    return spies;
  }

  function mockPassword(answer: () => Promise<{ password: string }>): void {
    vi.doMock("inquirer", () => ({ default: { prompt: answer } }));
  }

  it("never decrypts a locked session with --no-signer", async () => {
    writeConfig();
    writeSessionFile();
    const spies = spyOnDecryption();
    mockPassword(async () => {
      throw new Error("inquirer.prompt should not be called");
    });

    const ctx = await resolve({ signer: false, yes: true });
    ctx.provider.destroy();

    expect(ctx.signer).toBeUndefined();
    expect(spies.pbkdf2Sync).not.toHaveBeenCalled();
    expect(spies.createDecipheriv).not.toHaveBeenCalled();
    expectNoKeyLeak(out, tmpDir);
  });

  // The control for the test above: the same spies do see a decryption when
  // the flag is absent, so their silence there means something.
  it("decrypts the session, seen by the same spies, without --no-signer", async () => {
    writeConfig();
    writeSessionFile();
    const spies = spyOnDecryption();
    mockPassword(async () => ({ password: SESSION_PASSWORD }));
    process.stdin.isTTY = true;

    const ctx = await resolve({ yes: true });
    ctx.provider.destroy();

    expect(ctx.signer?.address).toBe(new ethers.Wallet(PRIVATE_KEY).address);
    expect(spies.createDecipheriv).toHaveBeenCalledTimes(1);
  });

  // #188: the session prompt is reached through resolvePrivateKey(), so a
  // wrong password here gets the session hint, not `wallet login`.
  it("hints at the password, then `wallet use`, on a wrong session password", async () => {
    writeConfig();
    writeSessionFile();
    mockPassword(async () => ({ password: "wrong horse 1" }));
    process.stdin.isTTY = true;

    const error = await resolve({ yes: true }).catch((e: Error) => e);

    expect((error as Error).message.split("\n").at(-1)).toBe(
      "\x1b[2mhint:\x1b[0m check the password. To start a fresh session, run `cmu wallet use <name>`.",
    );
    expect((error as Error).message).not.toContain("wallet login");
    expectNoKeyLeak([...out, (error as Error).message], tmpDir);
  });
});
