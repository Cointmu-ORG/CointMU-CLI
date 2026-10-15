import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { decryptSessionKey, type SessionData } from "../../src/utils/session";
import {
  PASSWORD,
  KEY,
  tmpDir,
  logged,
  output,
  clearLogged,
  readSession,
  writeSession,
  writeNetworks,
  KEY_B,
  ADDRESS_A,
  ADDRESS_B,
  walletsFile,
  readWallets,
  expectNoKeyLeak,
  storeHint,
  hintOf,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { walletCommands, save, use } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet use", () => {
  it("writes a session for the wallet that opens with its password", async () => {
    await save("deployer");
    clearLogged();
    await use("deployer");

    const session = readSession();
    expect(session.address).toBe(ADDRESS_A);
    expect(session.activeNetwork).toBe("local");
    expect(decryptSessionKey(PASSWORD, session)).toBe(KEY);
    expect(output()).toContain(
      `Active wallet is now 'deployer' (${ADDRESS_A})`,
    );
    expectNoKeyLeak();
  });

  it("marks the wallet the session holds in list", async () => {
    await save("a");
    await save("b", KEY_B);
    await use("b");
    clearLogged();

    const { runWalletList } = await walletCommands();
    await runWalletList();

    const line = (name: string) =>
      logged.find((l) => l.includes(` ${name} `)) ?? "";
    expect(line("b")).toContain("[*]");
    expect(line("a")).not.toContain("[*]");
  });

  it("keeps each project's active wallet independent", async () => {
    await save("a");
    await save("b", KEY_B);
    const p1 = path.join(tmpDir, "p1");
    const p2 = path.join(tmpDir, "p2");
    fs.mkdirSync(p1);
    fs.mkdirSync(p2);

    vi.mocked(process.cwd).mockReturnValue(p1);
    await use("a");
    vi.mocked(process.cwd).mockReturnValue(p2);
    await use("b");

    const sessionIn = (dir: string): SessionData =>
      JSON.parse(fs.readFileSync(path.join(dir, ".cmu-session"), "utf8"));
    expect(sessionIn(p1).address).toBe(ADDRESS_A);
    expect(sessionIn(p2).address).toBe(ADDRESS_B);
  });

  // Regression guard for #126 on the new path into the session.
  it("keeps an active network that is still saved", async () => {
    await save("deployer");
    writeSession("testnet");
    writeNetworks(["local", "testnet"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("testnet");
    expect(output()).toContain("Active network: testnet");
  });

  it("falls back to local when the picked network is gone, and says so", async () => {
    await save("deployer");
    writeSession("testnet");
    writeNetworks(["local"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("local");
    expect(output()).toContain("'testnet' is no longer saved");
  });

  // Issue #212: the local fallback only works while `local` is saved.
  const LOCAL_MISSING =
    "network 'local' is not saved - re-add it with `cmu network save http://127.0.0.1:8585 --name local`.";

  it("warns with the save command when the local fallback is not saved", async () => {
    await save("deployer");
    writeNetworks(["testnet"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("local");
    expect(output()).toContain(LOCAL_MISSING);
    expectNoKeyLeak();
  });

  it("does not claim a reset to local when local is gone too", async () => {
    await save("deployer");
    writeSession("testnet");
    writeNetworks(["staging"]);

    await use("deployer");

    expect(readSession().activeNetwork).toBe("local");
    expect(output()).toContain(LOCAL_MISSING);
    expect(output()).not.toContain("reset to local");
  });

  it("rejects a wrong password and leaves the session alone", async () => {
    await save("deployer");
    writeSession("testnet");
    const before = fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8");

    await expect(use("deployer", "wrong password 1")).rejects.toThrow(
      "wrong password for wallet 'deployer'",
    );
    expect(fs.readFileSync(path.join(tmpDir, ".cmu-session"), "utf8")).toBe(
      before,
    );
    expectNoKeyLeak();
  });

  it("hints at the wallet's own password on a wrong one, not the session's", async () => {
    await save("deployer");

    const error = await use("deployer", "wrong password 1").catch(
      (e: Error) => e,
    );

    expect(hintOf(error)).toBe(storeHint("deployer"));
    expect((error as Error).message).not.toContain("wallet login");
    expectNoKeyLeak();
  });

  it.each([
    ["a wrong password", () => {}, "wrong password 1"],
    [
      "an edited address",
      () => {
        const file = readWallets();
        file.wallets[0].address = ADDRESS_B;
        fs.writeFileSync(walletsFile(), JSON.stringify(file));
      },
      PASSWORD,
    ],
  ])(
    "does not leak the key through --verbose after %s",
    async (_, corrupt, password) => {
      await save("deployer");
      corrupt();
      const { fail } = await import("../../src/utils/errors");
      vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

      await use("deployer", password).catch(
        fail("wallet use", { verbose: true }),
      );

      expect(output()).toContain("wallet use failed");
      expectNoKeyLeak();
    },
  );

  it("refuses an entry whose plaintext address was edited", async () => {
    await save("deployer");
    const file = readWallets();
    file.wallets[0].address = ADDRESS_B;
    fs.writeFileSync(walletsFile(), JSON.stringify(file));

    await expect(use("deployer")).rejects.toThrow("has been modified");
    expect(fs.existsSync(path.join(tmpDir, ".cmu-session"))).toBe(false);
  });

  it("refuses a wallet that is not saved", async () => {
    const { runWalletUse } = await walletCommands();
    await expect(runWalletUse("ghost")).rejects.toThrow(
      "wallet 'ghost' is not saved",
    );
  });
});
