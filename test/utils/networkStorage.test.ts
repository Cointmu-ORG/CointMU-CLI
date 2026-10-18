import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

// Issue #228: `symbol` is an optional key in ~/.cmu-networks.json. Files
// written before it existed must read, and stay, exactly as they were.

describe("networkStorage symbol", () => {
  let tmpDir: string;
  const file = () => path.join(tmpDir, ".cmu-networks.json");
  const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-netstore-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const storage = () => import("../../src/utils/networkStorage");

  it("seeds a new file with the local devnet labelled CMU", async () => {
    const { loadNetworks } = await storage();

    expect(await loadNetworks()).toEqual([
      { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "CMU" },
    ]);
    expect(read()).toEqual([
      { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "CMU" },
    ]);
  });

  it("reads an old file without symbols as it is, and leaves it untouched", async () => {
    const old = `${JSON.stringify([{ name: "local", rpcUrl: "http://127.0.0.1:8585" }], null, 2)}\n`;
    fs.writeFileSync(file(), old);
    const { loadNetworks } = await storage();

    expect(await loadNetworks()).toEqual([
      { name: "local", rpcUrl: "http://127.0.0.1:8585" },
    ]);
    expect(fs.readFileSync(file(), "utf8")).toBe(old);
  });

  it("writes no symbol key for a network saved without one", async () => {
    fs.writeFileSync(file(), "[]");
    const { saveNetwork } = await storage();

    await saveNetwork("kampus", "http://127.0.0.1:9000");

    expect(read()).toEqual([
      { name: "kampus", rpcUrl: "http://127.0.0.1:9000" },
    ]);
  });

  it("stores the symbol of a new network", async () => {
    fs.writeFileSync(file(), "[]");
    const { saveNetwork } = await storage();

    await saveNetwork("kampus", "http://127.0.0.1:9000", "CMU");

    expect(read()).toEqual([
      { name: "kampus", rpcUrl: "http://127.0.0.1:9000", symbol: "CMU" },
    ]);
  });

  it("keeps the stored symbol when an update gives none", async () => {
    fs.writeFileSync(
      file(),
      JSON.stringify([
        { name: "kampus", rpcUrl: "http://127.0.0.1:9000", symbol: "CMU" },
      ]),
    );
    const { saveNetwork } = await storage();

    const entry = await saveNetwork("kampus", "http://127.0.0.1:9001");

    expect(read()).toEqual([
      { name: "kampus", rpcUrl: "http://127.0.0.1:9001", symbol: "CMU" },
    ]);
    // Returned as written, so `network save` can say the symbol was kept.
    expect(entry).toEqual(read()[0]);
  });

  it("replaces the stored symbol when an update gives one", async () => {
    fs.writeFileSync(
      file(),
      JSON.stringify([{ name: "local", rpcUrl: "http://127.0.0.1:8585" }]),
    );
    const { saveNetwork } = await storage();

    await saveNetwork("local", "http://127.0.0.1:8585", "CMU");

    expect(read()).toEqual([
      { name: "local", rpcUrl: "http://127.0.0.1:8585", symbol: "CMU" },
    ]);
  });
});

// Issue #213: the file was written with the process umask (0644 by default),
// unlike .cmu-wallets.json and .cmu-session, though saved RPC URLs can carry
// credentials. chmod on Windows only flips the read-only attribute; owner-only
// access there comes from the ACL inherited from %USERPROFILE%.

describe.skipIf(process.platform === "win32")("networks file mode", () => {
  let tmpDir: string;
  let previousUmask: number;
  const file = () => path.join(tmpDir, ".cmu-networks.json");
  const mode = () => fs.statSync(file()).mode & 0o777;
  const storage = () => import("../../src/utils/networkStorage");

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-netstore-mode-"));
    vi.stubEnv("HOME", tmpDir);
    vi.stubEnv("USERPROFILE", tmpDir);
    // The default most users have, and the one that made the file 0644.
    previousUmask = process.umask(0o022);
  });

  afterEach(() => {
    process.umask(previousUmask);
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a seeded file owner-only", async () => {
    const { loadNetworks } = await storage();

    await loadNetworks();

    expect(mode()).toBe(0o600);
  });

  it("writes the file owner-only after a save", async () => {
    const { saveNetwork } = await storage();

    await saveNetwork("creds", "http://user:pw@127.0.0.1:18546/rpc?k=1");

    expect(mode()).toBe(0o600);
  });

  it("writes the file owner-only after a delete", async () => {
    const { deleteNetwork, saveNetwork } = await storage();
    await saveNetwork("creds", "http://user:pw@127.0.0.1:18546/rpc?k=1");

    expect(await deleteNetwork("creds")).toBe(true);

    expect(mode()).toBe(0o600);
  });

  it("tightens a file that already had a looser mode when it is next written", async () => {
    fs.writeFileSync(file(), "[]", { mode: 0o644 });
    fs.chmodSync(file(), 0o644);
    const { deleteNetwork, saveNetwork } = await storage();

    await saveNetwork("creds", "http://user:pw@127.0.0.1:18546/rpc?k=1");
    expect(mode()).toBe(0o600);

    fs.chmodSync(file(), 0o644);
    await deleteNetwork("creds");
    expect(mode()).toBe(0o600);
  });

  it("leaves no temp file behind", async () => {
    const { deleteNetwork, saveNetwork } = await storage();

    await saveNetwork("creds", "http://127.0.0.1:18546");
    await deleteNetwork("creds");

    expect(fs.readdirSync(tmpDir)).toEqual([".cmu-networks.json"]);
  });

  it("keeps the old file intact when the write fails", async () => {
    const old = `${JSON.stringify([{ name: "local", rpcUrl: "http://127.0.0.1:8585" }], null, 2)}\n`;
    fs.writeFileSync(file(), old);
    vi.doMock("fs/promises", async (importOriginal) => {
      const real = await importOriginal<typeof import("fs/promises")>();
      return {
        ...real,
        rename: async () => {
          throw new Error("disk full");
        },
      };
    });
    try {
      const { saveNetwork } = await storage();

      await expect(
        saveNetwork("creds", "http://127.0.0.1:18546"),
      ).rejects.toThrow("disk full");

      expect(fs.readFileSync(file(), "utf8")).toBe(old);
      expect(fs.readdirSync(tmpDir)).toEqual([".cmu-networks.json"]);
    } finally {
      vi.doUnmock("fs/promises");
    }
  });
});
