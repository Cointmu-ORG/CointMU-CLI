import { vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FakeChain } from "../fakeChain";

// Address of the well-known Ganache key the deploy tests use; never fund it.
export const DEPLOYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
export const STRANGER = "0x00000000000000000000000000000000000000aa";
export const ARGS = "00".repeat(32);

/** Creation bytecode per artifact. Lib's user still has its placeholder. */
export const BYTECODE = {
  Token: "60aa01",
  Vault: "60bb02",
  Lib: "60cc03",
  LibUser: `73__$0123456789abcdef0123456789abcdef01$__60dd04`,
  IThing: "",
};

export let tmpDir: string;
export let chain: FakeChain;
export let out: string[];

export function writeArtifacts(names = Object.keys(BYTECODE)) {
  const dir = path.join(tmpDir, "artifacts");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      JSON.stringify({
        abi: [],
        evm: { bytecode: { object: (BYTECODE as any)[name] } },
      }),
    );
  }
}

export const recordFile = (network: string, name: string) =>
  path.join(tmpDir, "deployments", network, `${name}.json`);
export const readRecord = (network: string, name: string) =>
  JSON.parse(fs.readFileSync(recordFile(network, name), "utf8"));
export const output = () => out.join("\n");

/** Loads the SUT with ethers' provider swapped for the fake chain. */
export async function load() {
  vi.doMock("ethers", async (importOriginal) => {
    const real: any = await importOriginal();
    return {
      ...real,
      ethers: {
        ...real.ethers,
        JsonRpcProvider: class {
          constructor() {
            return chain.provider();
          }
        },
      },
    };
  });
  return import("../../src/utils/deployments");
}

export const LOCAL = {
  name: "local",
  url: "http://127.0.0.1:8585",
  chainId: 1912,
};

export function setUp(): void {
  vi.resetModules();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-records-"));
  vi.stubEnv("HOME", tmpDir);
  vi.stubEnv("USERPROFILE", tmpDir);
  chain = new FakeChain();
  out = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation((...a: unknown[]) => {
      out.push(a.join(" "));
    });
  }
  writeArtifacts();
}

export function tearDown(): void {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("ethers");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
