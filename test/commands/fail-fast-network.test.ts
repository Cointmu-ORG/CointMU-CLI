import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { stripVTControlCharacters } from "util";
import { encryptSessionKey } from "../../src/utils/session";
import { TEST_PBKDF2_ITERATIONS } from "../helpers/testPbkdf2";

// A network that cannot be resolved must fail before the user is asked to
// trust the project and before anything is compiled. Without cmu.config the
// lookup reads only JSON, so it runs before the trust prompt; with one, the
// config is code, so it runs after the prompt but still before compiling.
// The session password is asked for last, after compiling.

// well-known Ganache test key — never fund this
const KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const PASSWORD = "correct horse";
const TRUST_WARNING = "the following project files will be executed as code";
const NOT_SAVED =
  "network 'nope' is not saved in ~/.cmu-networks.json, and this folder has no cmu.config.ts or cmu.config.js.";

describe("network resolution fails fast", () => {
  let tmpDir: string;
  let logged: string[];
  /** compile, password and getNetwork, in the order they happened. */
  let events: string[];
  /** Replaces the provider's getNetwork() when set. */
  let getNetwork: () => Promise<unknown>;
  const realIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");

  beforeEach(() => {
    vi.resetModules();
    logged = [];
    events = [];
    getNetwork = async () => ({ name: "unknown", chainId: 1912n });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-fail-fast-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    vi.stubEnv("PRIVATE_KEY", "");
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
        logged.push(stripVTControlCharacters(a.map(String).join(" ")));
      });
    }
    // Non-interactive unless a test says otherwise: an unanswered trust
    // prompt then throws instead of hanging.
    Reflect.deleteProperty(process.stdin, "isTTY");
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify([{ name: "staging", rpcUrl: "http://127.0.0.1:8586" }]),
    );

    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {
        events.push("compile");
      },
    }));
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async (questions: Array<{ type: string }>) => {
          events.push(questions[0].type);
          return { password: PASSWORD, proceed: true };
        },
      },
    }));
    vi.doMock("ethers", async (importOriginal) => {
      const real: any = await importOriginal();
      return {
        ...real,
        ethers: {
          ...real.ethers,
          JsonRpcProvider: class {
            getNetwork = async () => {
              events.push("getNetwork");
              return getNetwork();
            };
            destroy = () => {};
          },
        },
      };
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.doUnmock("../../src/commands/compile");
    vi.doUnmock("inquirer");
    vi.doUnmock("ethers");
    vi.resetModules();
    if (realIsTTY) Object.defineProperty(process.stdin, "isTTY", realIsTTY);
    else Reflect.deleteProperty(process.stdin, "isTTY");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } } };`,
    );
  }

  function writeLockedSession(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        ...encryptSessionKey(PASSWORD, KEY, TEST_PBKDF2_ITERATIONS),
      }),
    );
  }

  async function messageOf(run: () => Promise<unknown>): Promise<string> {
    const error = await run().then(
      () => new Error("resolved"),
      (e: Error) => e,
    );
    return stripVTControlCharacters(error.message);
  }

  async function deploy(options: Record<string, unknown>) {
    const { runDeploy } = await import("../../src/commands/deploy");
    return runDeploy(options);
  }

  it("deploy: rejects an unknown -n before the trust prompt, with no config", async () => {
    // No --yes and no TTY: reaching the prompt would throw its own error.
    const message = await messageOf(() => deploy({ network: "nope" }));

    expect(message.split("\n")[0]).toBe(NOT_SAVED);
    expect(logged.join("\n")).not.toContain(TRUST_WARNING);
    expect(events).toEqual([]);
  });

  it("deploy: compiles nothing for an unknown -n, even under --yes", async () => {
    const message = await messageOf(() =>
      deploy({ network: "nope", yes: true }),
    );

    expect(message.split("\n")[0]).toBe(NOT_SAVED);
    expect(logged).not.toContain("Compiling contracts...");
    expect(events).not.toContain("compile");
  });

  it("deploy: with a config, rejects an undefined network after trust but before compiling", async () => {
    writeConfig();

    const message = await messageOf(() =>
      deploy({ network: "nope", yes: true }),
    );

    expect(message.split("\n")[0]).toBe(
      "network 'nope' is not defined in cmu.config.js.",
    );
    expect(logged.join("\n")).toContain(TRUST_WARNING);
    expect(events).not.toContain("compile");
  });

  it("deploy: asks for the session password only after compiling", async () => {
    writeConfig();
    writeLockedSession();
    process.stdin.isTTY = true;
    // Nothing to run: the run ends after the banner, once the key is resolved.
    fs.rmSync(path.join(tmpDir, "deploy", "01_deploy.js"));

    await deploy({ yes: true });

    expect(events).toEqual(["compile", "password"]);
  });

  it("deploy: an unreachable saved network fails before the password prompt", async () => {
    writeLockedSession();
    process.stdin.isTTY = true;
    getNetwork = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const message = await messageOf(() =>
      deploy({ network: "staging", yes: true }),
    );

    expect(message).toMatch(/is unreachable/);
    expect(events).toEqual(["compile", "getNetwork"]);
  });

  it("console: rejects an unknown -n before the trust prompt, with no config", async () => {
    const { runConsole } = await import("../../src/commands/console");

    const message = await messageOf(() => runConsole({ network: "nope" }));

    expect(message.split("\n")[0]).toBe(NOT_SAVED);
    expect(logged.join("\n")).not.toContain(TRUST_WARNING);
  });

  it("console: with a config, rejects an undefined network after trust", async () => {
    writeConfig();
    const { runConsole } = await import("../../src/commands/console");

    const message = await messageOf(() =>
      runConsole({ network: "nope", yes: true }),
    );

    expect(message.split("\n")[0]).toBe(
      "network 'nope' is not defined in cmu.config.js.",
    );
    expect(logged.join("\n")).toContain(TRUST_WARNING);
    expect(events).not.toContain("getNetwork");
  });

  it("explorer: rejects an unknown -n before the trust prompt, with no config", async () => {
    const { runExplorer } = await import("../../src/commands/explorer");

    const message = await messageOf(() =>
      runExplorer({ network: "nope", block: "0" }),
    );

    expect(message.split("\n")[0]).toBe(NOT_SAVED);
    expect(logged.join("\n")).not.toContain(TRUST_WARNING);
    expect(events).not.toContain("getNetwork");
  });
});
