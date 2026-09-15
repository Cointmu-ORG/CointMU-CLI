import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { encryptSessionKey } from "../../src/utils/session";

// getDynamicNetwork's "never resolve/prompt a private key" regression is
// covered in session.test.ts. This file covers getDeployNetwork's resolution
// priority (config.wallet.privateKey > PRIVATE_KEY env > .cmu-session) and the
// noPrompt option.

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
});
