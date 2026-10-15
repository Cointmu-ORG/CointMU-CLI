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
