import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { hashOf } from "../fakeChain";
import {
  DEPLOYER,
  STRANGER,
  ARGS,
  BYTECODE,
  tmpDir,
  chain,
  load,
  LOCAL,
  setUp,
  tearDown,
} from "../helpers/deploymentsEnv";

beforeEach(setUp);
afterEach(tearDown);

describe("matchArtifact", () => {
  it("never matches an artifact with no bytecode", async () => {
    const { loadArtifactBytecodes, matchArtifact } = await load();
    const artifacts = await loadArtifactBytecodes(tmpDir);

    expect(artifacts.map((a) => a.name)).not.toContain("IThing");
    expect(matchArtifact("0xdeadbeef", artifacts)).toEqual({});
  });

  it("prefers the longest bytecode that prefixes the input", async () => {
    const { matchArtifact } = await load();
    const artifacts = [
      { name: "Short", bytecode: "60aa" },
      { name: "Long", bytecode: "60aa01" },
    ];

    expect(matchArtifact(`0x60AA01${ARGS}`, artifacts)).toEqual({
      name: "Long",
    });
  });

  it("names nothing when two artifacts tie", async () => {
    const { matchArtifact } = await load();
    const artifacts = [
      { name: "A", bytecode: "60aa01" },
      { name: "B", bytecode: "60aa01" },
    ];

    expect(matchArtifact("0x60aa01", artifacts)).toEqual({
      ambiguous: ["A", "B"],
    });
  });
});

describe("scanDeployments", () => {
  it("finds a raw creation from a hand-written script", async () => {
    const { scanDeployments } = await load();
    const address = chain.create(
      DEPLOYER,
      `0x${BYTECODE.Token}${ARGS}`,
      "0x6001",
    );

    const found = await scanDeployments(chain.provider(), DEPLOYER, 1, 1, 1);

    expect(found).toEqual([
      expect.objectContaining({
        address,
        blockNumber: 1,
        codeHash: hashOf("0x6001"),
        timestamp: new Date((1_700_000_000 + 1) * 1000).toISOString(),
      }),
    ]);
  });

  it("ignores creations sent by anyone else in the same range", async () => {
    const { scanDeployments } = await load();
    chain.create(STRANGER, `0x${BYTECODE.Token}`);
    const mine = chain.create(DEPLOYER, `0x${BYTECODE.Vault}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);

    const found = await scanDeployments(chain.provider(), DEPLOYER, 1, 3, 1);

    expect(found.map((f) => f.address)).toEqual([mine]);
  });

  it("does not see a contract a factory created", async () => {
    const { scanDeployments } = await load();
    chain.factoryCreate(DEPLOYER, "0x00000000000000000000000000000000000000fa");

    expect(await scanDeployments(chain.provider(), DEPLOYER, 1, 1, 1)).toEqual(
      [],
    );
  });

  it("stops once it has seen every transaction the nonce delta promised", async () => {
    const { scanDeployments } = await load();
    chain.create(DEPLOYER, `0x${BYTECODE.Token}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);
    chain.create(STRANGER, `0x${BYTECODE.Token}`);

    await scanDeployments(chain.provider(), DEPLOYER, 1, 3, 1);

    expect(chain.calls.filter((c) => c === "getBlock")).toHaveLength(1);
  });
});

describe("networkDir", () => {
  it.each(["../x", "a/b", "..", "a\\b", "", ".hidden", "x".repeat(65)])(
    "rejects %j as a directory name",
    async (name) => {
      const { networkDir } = await load();
      await expect(networkDir(tmpDir, name)).rejects.toThrow(
        /cannot be used as a deployments\/ directory/,
      );
    },
  );

  it.each([
    "con",
    "CON",
    "prn",
    "aux",
    "Nul",
    "com1",
    "Com1",
    "COM9",
    "lpt1",
    "LPT9",
  ])("rejects the Windows device name %s", async (name) => {
    const { networkDir } = await load();
    await expect(networkDir(tmpDir, name)).rejects.toThrow(
      /not a Windows device name/,
    );
  });

  it.each(["com10", "console", "kampus", "local", "my_net-2"])(
    "accepts %s",
    async (name) => {
      const { networkDir } = await load();
      await expect(networkDir(tmpDir, name)).resolves.toBe(
        path.join(tmpDir, "deployments", name),
      );
    },
  );

  it("treats 'Local' as a collision once deployments/local exists", async () => {
    const { networkDir } = await load();
    fs.mkdirSync(path.join(tmpDir, "deployments", "local"), {
      recursive: true,
    });

    await expect(networkDir(tmpDir, "Local")).rejects.toThrow(
      "network 'Local' collides with the existing deployments/local/ on a case-insensitive filesystem.",
    );
    await expect(networkDir(tmpDir, "local")).resolves.toBeDefined();
  });

  it("records nothing outside deployments/ for a traversal name", async () => {
    const { startRecording } = await load();

    expect(
      await startRecording({ ...LOCAL, name: "../escape" }, DEPLOYER, tmpDir),
    ).toBeUndefined();
    expect(fs.readdirSync(tmpDir).sort()).toEqual(["artifacts"]);
    expect(chain.calls).not.toContain("getBlockNumber");
  });
});
