import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

// runDeploy() used to call process.exit() from inside its --ping and --config
// branches, so neither could be observed without stubbing the process. It now
// resolves, and the command handler does the exiting.

describe("runDeploy exits", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    // The pingNetwork suite above registers an ethers mock with no Wallet, and
    // vi.resetModules() clears the module cache but not the mock registry.
    vi.doUnmock("ethers");
    // The import at the top of this file already loaded deploy.ts with the
    // real compile module bound to it. Without this, mockCompile() only works
    // when a suite above happened to reset modules first.
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-deploy-"));
    fs.mkdirSync(path.join(tmpDir, "deploy"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.PRIVATE_KEY =
      // well-known Ganache test key — never fund this
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  /** Stubs out compiling, which is not what these are about. */
  function mockCompile() {
    vi.doMock("../../src/commands/compile", () => ({
      runCompile: async () => {},
    }));
  }

  it("finishes --config without running any deploy script", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
  });

  // A locked .cmu-session resolves to no key at all under --config, which used
  // to be fatal. --config never signs, so it now reports the gap as a field.
  it("prints the config with no deployer when no key is reachable", async () => {
    delete process.env.PRIVATE_KEY;
    mockCompile();
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
    expect(logged).toContain("Deployer     : unavailable (no key)");
    expect(logged).toContain("Private key  : unavailable (no key)");
  });

  it("still prints the deployer under --config when a key is reachable", async () => {
    mockCompile();
    const logged: string[] = [];
    vi.mocked(console.log).mockImplementation((...a: unknown[]) => {
      logged.push(a.join(" "));
    });
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(
      runDeploy({ config: true, yes: true }),
    ).resolves.toBeUndefined();
    expect(logged).toContain(
      "Deployer     : 0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    );
    expect(logged.some((l) => l.startsWith("Private key  : 0x59c"))).toBe(true);
  });

  // The relaxation above is scoped to --config: a real deploy has to sign, so
  // a missing key must still stop it before anything is broadcast.
  it("still refuses a real deploy with no key", async () => {
    delete process.env.PRIVATE_KEY;
    fs.writeFileSync(
      path.join(tmpDir, "deploy", "01_deploy.js"),
      "throw new Error('this script must not run');",
    );
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).rejects.toThrow(
      /no private key available for signing/,
    );
  });

  it("finishes --ping when the endpoint answers", async () => {
    mockCompile();
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getNetwork = async () => ({ name: "cointmu", chainId: 1912n });
        },
      },
    }));
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ ping: true, yes: true })).resolves.toBeUndefined();
  });

  it("throws rather than exiting when the deploy directory is missing", async () => {
    fs.rmSync(path.join(tmpDir, "deploy"), { recursive: true });
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as any);
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).rejects.toThrow(
      /deploy\/ directory not found/,
    );
    expect(exit).not.toHaveBeenCalled();
  });

  it("finishes when there is nothing in deploy/ to run", async () => {
    mockCompile();
    const { runDeploy } = await import("../../src/commands/deploy");

    await expect(runDeploy({ yes: true })).resolves.toBeUndefined();
  });
});
