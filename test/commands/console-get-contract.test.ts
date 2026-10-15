import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { PRIVATE_KEY, ADDRESS, ABI } from "../helpers/consoleEnv";

describe("getContract", () => {
  let tmpDir: string;
  // A dead endpoint: building a provider, a wallet or a contract dials
  // nothing, and no test here calls one.
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:59999");
  const signer = new ethers.Wallet(PRIVATE_KEY, provider);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-console-"));
    fs.mkdirSync(path.join(tmpDir, "artifacts"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeArtifact(name: string, body: unknown): void {
    fs.writeFileSync(
      path.join(tmpDir, "artifacts", `${name}.json`),
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  async function loadGetContract(ctx: { provider: any; signer?: any }) {
    const { makeGetContract } = await import("../../src/commands/console");
    return makeGetContract(ctx);
  }

  it("attaches the compiled ABI to the given address, connected to the signer", async () => {
    writeArtifact("Token", { abi: ABI, evm: { bytecode: { object: "0x60" } } });

    const getContract = await loadGetContract({ provider, signer });
    const token = getContract("Token", ADDRESS);

    expect(token.target).toBe(ADDRESS);
    expect(token.runner).toBe(signer);
    expect(token.interface.getFunction("totalSupply")).toBeTruthy();
  });

  it("falls back to the provider when the console has no signer", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });
    const token = getContract("Token", ADDRESS);

    expect(token.runner).toBe(provider);
  });

  it("points at `cmu compile` when the artifact is missing", async () => {
    const getContract = await loadGetContract({ provider });

    expect(() => getContract("Ghost", ADDRESS)).toThrow(/cmu compile/);
  });

  it("reports an artifact with no abi, and one that is not JSON at all", async () => {
    writeArtifact("NoAbi", { evm: { bytecode: { object: "0x60" } } });
    writeArtifact("Broken", "{ not json");

    const getContract = await loadGetContract({ provider });

    expect(() => getContract("NoAbi", ADDRESS)).toThrow(/no abi/);
    expect(() => getContract("Broken", ADDRESS)).toThrow(/no abi/);
  });

  it("requires an explicit address", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });

    expect(() => (getContract as any)("Token")).toThrow(/requires an address/);
    // The hint names the whole fix: the recorded path, and the explicit one.
    expect(() => (getContract as any)("Token")).toThrow(
      'await getDeployed("Name")',
    );
  });

  it("rejects a name-shaped address instead of resolving it as ENS", async () => {
    writeArtifact("Token", { abi: ABI });

    const getContract = await loadGetContract({ provider });

    expect(() => getContract("Token", "Token")).toThrow(
      /not a valid contract address/,
    );
  });
});
