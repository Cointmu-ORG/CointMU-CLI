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

    // Issue #228: both scaffolded networks are the CointMU chain.
    it(`labels both scaffolded networks CMU for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);
      const config = fs.readFileSync(path.join(tmpDir, file), "utf8");
      const mainnet = config.indexOf("mainnet:");

      expect(config.slice(0, mainnet)).toContain('symbol: "CMU"');
      expect(config.slice(mainnet)).toContain('symbol: "CMU"');
    });

    it(`writes ${file}, .env.example and .gitignore for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);

      expect(fs.readdirSync(tmpDir).sort()).toEqual(
        [".env.example", ".gitignore", file].sort(),
      );
      expect(
        fs.readFileSync(path.join(tmpDir, ".gitignore"), "utf8"),
      ).toContain(".cmu-session");
    });

    // writeSessionFile writes .cmu-session.<pid>.<hex>.tmp before the rename;
    // a crash in between must not leave it committable.
    it(`ignores the session's temp files for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);

      const lines = fs
        .readFileSync(path.join(tmpDir, ".gitignore"), "utf8")
        .split("\n");
      expect(lines).toContain(".cmu-session.*.tmp");
    });

    // #209: `wallet use` keeps a session it cannot open as
    // .cmu-session.bak-<time>, encrypted key and all.
    it(`ignores the session's backups for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);

      const lines = fs
        .readFileSync(path.join(tmpDir, ".gitignore"), "utf8")
        .split("\n");
      expect(lines).toContain(".cmu-session.bak-*");
    });

    it(`ignores only the local devnet's deployment records for ${language}`, async () => {
      await generateConfigFiles(tmpDir, language);

      const lines = fs
        .readFileSync(path.join(tmpDir, ".gitignore"), "utf8")
        .split("\n");
      expect(lines).toContain("deployments/local/");
      expect(lines).not.toContain("deployments/");
      expect(lines).not.toContain("deployments");
    });
  }
});
