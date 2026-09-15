import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { loadConfig } from "../../src/utils/config";

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-config-"));
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("throws a clear error when cmu.config.ts is absent from the cwd", async () => {
    await expect(loadConfig()).rejects.toThrow(/cmu\.config\.ts not found/);
  });

  it("loads a real cmu.config.ts without the invalid 'typescript@5' module error", async () => {
    fs.mkdirSync(path.join(tmpDir, "node_modules"));
    fs.symlinkSync(
      path.resolve(__dirname, "../../node_modules/typescript"),
      path.join(tmpDir, "node_modules", "typescript"),
      "dir",
    );
    fs.writeFileSync(
      path.join(tmpDir, "cmu.config.ts"),
      `export default { network: { explorerUrl: "http://localhost:3000" } };`,
    );

    const config = await loadConfig();

    expect(config.network?.explorerUrl).toBe("http://localhost:3000");
  });
});
