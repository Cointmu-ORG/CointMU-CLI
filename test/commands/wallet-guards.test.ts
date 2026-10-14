import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  tmpDir,
  output,
  KEY_B,
  ADDRESS_B,
  walletsFile,
  readWallets,
  writeKeySession,
  expectNoKeyLeak,
  hintOf,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { walletCommands, save, use, type Commands } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

describe("named wallets without a terminal", () => {
  beforeEach(async () => {
    await save("deployer");
    process.stdin.isTTY = false;
  });

  it("save fails instead of prompting", async () => {
    const { runWalletSave } = await walletCommands();
    await expect(runWalletSave("other")).rejects.toThrow(
      "non-interactive session",
    );
  });

  it("use fails instead of prompting", async () => {
    const { runWalletUse } = await walletCommands();
    await expect(runWalletUse("deployer")).rejects.toThrow(
      "non-interactive session",
    );
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });

  it("delete without --yes fails instead of prompting", async () => {
    const { runWalletDelete } = await walletCommands();
    await expect(runWalletDelete("deployer")).rejects.toThrow("--yes");
    expect(readWallets().wallets).toHaveLength(1);
  });

  // #188: one case per requireInteractive() call site. PRIVATE_KEY stands in
  // for a session key but cannot save, select or delete a wallet, so none may
  // suggest it; they either have a flag of their own or no way around a
  // terminal. (transfer: see its suite.)
  const TERMINAL = "hint: run this in a terminal.";
  it.each([
    [
      "create --save",
      TERMINAL,
      (m: Commands) => m.runWalletCreate({ save: "other" }),
    ],
    ["save", TERMINAL, (m: Commands) => m.runWalletSave("other")],
    ["use", TERMINAL, (m: Commands) => m.runWalletUse("deployer")],
    [
      "delete",
      "hint: re-run with --yes to delete without asking.",
      (m: Commands) => m.runWalletDelete("deployer"),
    ],
  ])("%s names the right way out", async (_, hint, run) => {
    const error = await run(await walletCommands()).catch((e: Error) => e);

    expect(hintOf(error)).toBe(hint);
    expect((error as Error).message).not.toContain("PRIVATE_KEY");
    expectNoKeyLeak();
  });

  it("use over an unsaved session names `save --session`, not PRIVATE_KEY", async () => {
    writeKeySession(ADDRESS_B);
    const { runWalletUse } = await walletCommands();

    const error = await runWalletUse("deployer").catch((e: Error) => e);

    expect(hintOf(error)).toBe(
      "hint: keep the key first with `cmu wallet save <name> --session`, or run this in a terminal to confirm.",
    );
    expect((error as Error).message).not.toContain("PRIVATE_KEY");
    expectNoKeyLeak();
  });

  it("delete --yes and list still work", async () => {
    const { runWalletDelete, runWalletList } = await walletCommands();
    await runWalletDelete("deployer", { yes: true });
    await runWalletList();
    expect(output()).toContain("No saved wallets.");
  });
});

// chmod on Windows only flips the read-only attribute; owner-only access there
// comes from the ACL inherited from %USERPROFILE%, which this cannot assert.
describe.skipIf(process.platform === "win32")("file permissions", () => {
  const mode = (file: string) => fs.statSync(file).mode & 0o777;

  it("writes the wallets file and the session owner-only", async () => {
    await save("deployer");
    expect(mode(walletsFile())).toBe(0o600);

    await use("deployer");
    expect(mode(path.join(tmpDir, ".cmu-session"))).toBe(0o600);
  });

  it("tightens a wallets file that already had a looser mode", async () => {
    await save("a");
    fs.chmodSync(walletsFile(), 0o644);
    await save("b", KEY_B);
    expect(mode(walletsFile())).toBe(0o600);

    fs.chmodSync(walletsFile(), 0o644);
    const { runWalletDelete } = await walletCommands();
    await runWalletDelete("a", { yes: true });
    expect(mode(walletsFile())).toBe(0o600);
  });
});

describe("an unreadable wallets file", () => {
  it.each([
    [
      "a newer version",
      JSON.stringify({ version: 2, wallets: [] }),
      "newer version",
    ],
    ["malformed JSON", "{ not json", "not a valid wallets file"],
    ["a bare array", "[]", "not a valid wallets file"],
    ["null", "null", "not a valid wallets file"],
  ])(
    "with %s is refused and never overwritten",
    async (_, content, message) => {
      fs.writeFileSync(walletsFile(), content);

      const { runWalletList, runWalletSave } = await walletCommands();
      await expect(runWalletList()).rejects.toThrow(message);
      await expect(runWalletSave("deployer")).rejects.toThrow(message);
      expect(fs.readFileSync(walletsFile(), "utf8")).toBe(content);
    },
  );
});
