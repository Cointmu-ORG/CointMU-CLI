import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { generateConfigFiles } from "../../src/utils/configGenerator";

// Issue #86 (d): the scaffolded mainnet entry used to point at a hardcoded
// plaintext-HTTP internal IP.

describe("generateConfigFiles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmu-config-gen-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  for (const [language, file] of [
    ["typescript", "cmu.config.ts"],
    ["javascript", "cmu.config.js"],
  ] as const) {
    it(`scaffolds no plaintext mainnet endpoint for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);
      const config = fs.readFileSync(path.join(tmpDir, file), "utf8");

      const mainnet = config.slice(config.indexOf("mainnet:"));
      expect(mainnet).not.toContain("http://");
      expect(mainnet).toMatch(/url:\s*""/);
      // The local DevNet entry is still plain http on loopback, as intended.
      expect(config).toContain('url: "http://127.0.0.1:8585"');
      expect(config).toContain("https://");
    });
  }
});
