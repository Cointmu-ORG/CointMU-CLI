import { vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import { ABI, PRIVATE_KEY } from "./consoleEnv";

export const TOKEN = "0x00000000000000000000000000000000000000c1";
/** Runtime code as it sits on-chain, and as the artifact has it. */
export const RUNTIME = "0x6080604052348015600f57600080fd5b50";
/** With a 32-byte immutable at byte 2: zero in the artifact, set on-chain. */
export const RUNTIME_IMM_ARTIFACT = `0x6080${"00".repeat(32)}5b`;
export const RUNTIME_IMM_CHAIN = `0x6080${"ab".repeat(32)}5b`;

export let tmpDir: string;
export let out: string[];
export let code: string;
export let liveChainId: bigint;
export const provider = {
  getNetwork: async () => ({ chainId: liveChainId }),
  getCode: vi.fn(async () => code),
};
export const signer = new ethers.Wallet(PRIVATE_KEY);

/** Sets what the fake provider's getCode returns; importers cannot assign `code`. */
export function setCode(value: string): void {
  code = value;
}

export function getDeployedSetUp(): void {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-getdeployed-"));
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  out = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
  }
  code = RUNTIME;
  liveChainId = 1912n;
  provider.getCode.mockClear();
  writeArtifact("Token", RUNTIME);
}

export function getDeployedTearDown(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

export function writeArtifact(
  name: string,
  runtime: string | undefined,
  immutableReferences: unknown = {},
): void {
  fs.mkdirSync(path.join(tmpDir, "artifacts"), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, "artifacts", `${name}.json`),
    JSON.stringify({
      abi: ABI,
      evm: {
        bytecode: { object: "60aa" },
        ...(runtime && {
          deployedBytecode: { object: runtime, immutableReferences },
        }),
      },
    }),
  );
}

export function writeRecord(
  network: string,
  overrides: Record<string, unknown> = {},
  name = "Token",
): string {
  const dir = path.join(tmpDir, "deployments", network);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      format: 1,
      contract: name,
      network,
      chainId: 1912,
      address: TOKEN,
      deployer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      txHash: `0x${"11".repeat(32)}`,
      blockNumber: 3,
      timestamp: "2026-10-13T08:00:00.000Z",
      codeHash: ethers.keccak256(code),
      ...overrides,
    }),
  );
  return file;
}

export async function load(network = "local") {
  const { makeGetDeployed } = await import("../../src/commands/console");
  return makeGetDeployed({ provider, signer, network });
}
