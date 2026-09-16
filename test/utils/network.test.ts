import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { encryptSessionKey } from "../../src/utils/session";

// getDynamicNetwork's "never resolve/prompt a private key" regression is
// covered in session.test.ts. This file covers getDeployNetwork's resolution
// priority (config.wallet.privateKey > PRIVATE_KEY env > .cmu-session) and the
// noPrompt option.

// well-known Ganache test key — never fund this
const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const SESSION_PASSWORD = "correct horse";

describe("getDeployNetwork private key resolution", () => {
  let tmpDir: string;
  const prevKey = process.env.PRIVATE_KEY;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-deploy-net-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    delete process.env.PRIVATE_KEY;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (prevKey === undefined) delete process.env.PRIVATE_KEY;
    else process.env.PRIVATE_KEY = prevKey;
  });

  function writeJsConfig(extra: string): void {
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.js"),
      `module.exports = { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } }, ` +
        `${extra} };`,
    );
  }

  function writeTsConfig(extra: string): void {
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.symlinkSync(
      path.resolve(__dirname, "../../node_modules/typescript"),
      path.join(tmpDir, "node_modules", "typescript"),
      "dir",
    );
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.ts"),
      `export default { defaultNetwork: "local", ` +
        `networks: { local: { url: "http://127.0.0.1:8585", chainId: 1912 } }, ` +
        `${extra} };`,
    );
  }

  function writeSessionFile(): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        activeNetwork: "local",
        ...encryptSessionKey(SESSION_PASSWORD, PRIVATE_KEY),
      }),
    );
  }

  it("prefers config.wallet.privateKey over the PRIVATE_KEY env var", async () => {
    writeJsConfig(`wallet: { privateKey: "0xconfig" }`);
    process.env.PRIVATE_KEY = "0xenv";

    const { getDeployNetwork } = await import("../../src/utils/network");
    const network = await getDeployNetwork("local", { noPrompt: true });

    expect(network.privateKey).toBe("0xconfig");
  });

  it("falls back to the PRIVATE_KEY env var when config carries no wallet key", async () => {
    writeJsConfig(`wallet: {}`);
    writeSessionFile(); // present, but env must win over it
    process.env.PRIVATE_KEY = "0xenv";

    const { getDeployNetwork } = await import("../../src/utils/network");
    const network = await getDeployNetwork("local", { noPrompt: true });

    expect(network.privateKey).toBe("0xenv");
  });

  it("falls back to the encrypted .cmu-session when neither config nor env provide a key", async () => {
    writeJsConfig(`wallet: {}`);
    writeSessionFile();
    vi.doMock("inquirer", () => ({
      default: { prompt: async () => ({ password: SESSION_PASSWORD }) },
    }));

    const { getDeployNetwork } = await import("../../src/utils/network");
    const network = await getDeployNetwork("local");

    expect(network.privateKey).toBe(PRIVATE_KEY);
  });

  it("skips the password prompt when noPrompt is set", async () => {
    writeJsConfig(`wallet: {}`);
    writeSessionFile();
    vi.doMock("inquirer", () => ({
      default: {
        prompt: async () => {
          throw new Error("inquirer.prompt should not be called");
        },
      },
    }));

    const { getDeployNetwork } = await import("../../src/utils/network");
    // Resolving (instead of throwing from the mocked prompt) proves no prompt.
    const network = await getDeployNetwork("local", { noPrompt: true });

    expect(network.privateKey).toBeUndefined();
  });

  it("loads a real cmu.config.ts without the invalid 'typescript@5' module error", async () => {
    writeTsConfig(`wallet: { privateKey: "0xconfig" }`);

    const { getDeployNetwork } = await import("../../src/utils/network");
    const network = await getDeployNetwork("local", { noPrompt: true });

    expect(network.privateKey).toBe("0xconfig");
    expect(network.url).toBe("http://127.0.0.1:8585");
  });
});

// runNetworkInfo, runNetworkPing and runNetworkList each carried their own copy
// of "read the session, look the active network up in .cmu-networks.json".
// These cover the shared pair that replaced them.

describe("activeNetwork", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-active-net-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
    // networkStorage keys .cmu-networks.json off os.homedir().
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(activeNetwork?: string): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({
        address: "0xTest",
        ...(activeNetwork && { activeNetwork }),
      }),
    );
  }

  function writeNetworks(entries: { name: string; rpcUrl: string }[]): void {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-networks.json"),
      JSON.stringify(entries),
    );
  }

  it("returns the saved entry the session points at", async () => {
    writeSession("staging");
    writeNetworks([{ name: "staging", rpcUrl: "https://rpc.example.com" }]);

    const { activeNetwork } = await import("../../src/utils/network");

    expect(await activeNetwork()).toEqual({
      name: "staging",
      rpcUrl: "https://rpc.example.com",
    });
  });

  it("reports a missing session, and points at login by default", async () => {
    const { activeNetwork } = await import("../../src/utils/network");

    await expect(activeNetwork()).rejects.toThrow(/no active session/);
    await expect(activeNetwork()).rejects.toThrow(/cmu wallet login/);
  });

  it("lets the caller supply the hint for a missing session", async () => {
    const { activeNetwork } = await import("../../src/utils/network");

    await expect(activeNetwork("pass a network name.")).rejects.toThrow(
      /pass a network name\./,
    );
  });

  it("separates a session that never picked a network from a missing one", async () => {
    writeSession();
    const { activeNetwork } = await import("../../src/utils/network");

    await expect(activeNetwork()).rejects.toThrow(
      /no active network in the session/,
    );
  });

  it("reports an active network that is no longer saved", async () => {
    writeSession("deleted-one");
    writeNetworks([{ name: "local", rpcUrl: "http://127.0.0.1:8585" }]);

    const { activeNetwork } = await import("../../src/utils/network");

    await expect(activeNetwork()).rejects.toThrow(
      /'deleted-one' is no longer saved/,
    );
  });
});

describe("activeNetworkName", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-active-name-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("falls back to local with no session, rather than throwing", async () => {
    const { activeNetworkName } = await import("../../src/utils/network");

    expect(await activeNetworkName()).toBe("local");
  });

  it("falls back to local when the session never picked one", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ address: "0xTest" }),
    );
    const { activeNetworkName } = await import("../../src/utils/network");

    expect(await activeNetworkName()).toBe("local");
  });

  it("returns the name the session selected", async () => {
    fs.writeFileSync(
      path.join(tmpDir, ".cmu-session"),
      JSON.stringify({ address: "0xTest", activeNetwork: "staging" }),
    );
    const { activeNetworkName } = await import("../../src/utils/network");

    expect(await activeNetworkName()).toBe("staging");
  });
});
