import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSessionKey } from "../../src/utils/session";
import {
  PASSWORD,
  KEY,
  output,
  clearLogged,
  readSession,
  KEY_B,
  readWallets,
  setUp,
  tearDown,
} from "../helpers/walletEnv";
import { walletCommands, save, use } from "../helpers/walletSut";

beforeEach(setUp);
afterEach(tearDown);

describe("wallet delete", () => {
  it("removes the entry after --yes", async () => {
    await save("a");
    await save("b", KEY_B);

    const { runWalletDelete, runWalletList } = await walletCommands();
    await runWalletDelete("a", { yes: true });
    clearLogged();
    await runWalletList();

    expect(readWallets().wallets.map((w) => w.name)).toEqual(["b"]);
    expect(output()).not.toMatch(/\| a /);
  });

  it("asks first, and a no deletes nothing", async () => {
    await save("a");
    const { runWalletDelete } = await walletCommands({ proceed: false });

    await runWalletDelete("a");

    expect(output()).toContain("Nothing deleted.");
    expect(readWallets().wallets).toHaveLength(1);
  });

  it("leaves a session that already uses the wallet working", async () => {
    await save("deployer");
    await use("deployer");
    clearLogged();

    const { runWalletDelete } = await walletCommands({ proceed: true });
    await runWalletDelete("deployer");

    expect(readWallets().wallets).toEqual([]);
    expect(decryptSessionKey(PASSWORD, readSession())).toBe(KEY);
    expect(output()).toContain("keep their own encrypted copy");
  });

  it("refuses a wallet that is not saved", async () => {
    const { runWalletDelete } = await walletCommands();
    await expect(runWalletDelete("ghost", { yes: true })).rejects.toThrow(
      "wallet 'ghost' is not saved",
    );
  });
});
