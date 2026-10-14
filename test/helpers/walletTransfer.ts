import { vi } from "vitest";
import { ADDRESS_B, clearLogged, PASSWORD, writeNetworks } from "./walletEnv";
import { askingCommands, save, use } from "./walletSut";

export const TO = ADDRESS_B;
export const TX_HASH = `0x${"ab".repeat(32)}`;
export const GWEI = 1_000_000_000n;
export const ETH = 10n ** 18n;
export const AMOUNT_WEI = 1_500_000_000_000_000_000n; // "1.5"
export const MAX_FEE_1559 = 21_000n * 3n * GWEI;

export let sendTransaction: ReturnType<typeof vi.fn>;
export let wait: ReturnType<typeof vi.fn>;
export let send: ReturnType<typeof vi.fn>;

export type Chain = {
  balance: bigint;
  feeData: [bigint | null, bigint | null, bigint | null];
  code: string;
  gas: bigint;
  networkError?: Error;
  estimateError?: Error;
  sendError?: Error;
  refuse?: boolean;
  wait?: () => Promise<unknown>;
  /** The node's answer to eth_mining, asked only after a missed confirmation. */
  mining?: () => Promise<unknown>;
};

/**
 * Stubs the provider and the signer. With `refuse`, signing throws: the
 * refusal tests also assert it was never reached, which is the only proof
 * that nothing was signed.
 */
export async function mockChain(over: Partial<Chain> = {}): Promise<void> {
  const { ethers } = await import("ethers");
  const chain: Chain = {
    balance: 10n * ETH,
    // gasPrice, maxFeePerGas, maxPriorityFeePerGas
    feeData: [2n * GWEI, 3n * GWEI, 1n * GWEI],
    code: "0x",
    gas: 21_000n,
    ...over,
  };
  const P = ethers.JsonRpcProvider.prototype;
  vi.spyOn(P, "getNetwork").mockImplementation(async () => {
    if (chain.networkError) throw chain.networkError;
    return new ethers.Network("local", 1912n);
  });
  vi.spyOn(P, "getBalance").mockImplementation(async () => chain.balance);
  vi.spyOn(P, "getFeeData").mockImplementation(
    async () => new ethers.FeeData(...chain.feeData),
  );
  vi.spyOn(P, "getCode").mockImplementation(async () => chain.code);
  vi.spyOn(P, "estimateGas").mockImplementation(async () => {
    if (chain.estimateError) throw chain.estimateError;
    return chain.gas;
  });
  send = vi.fn(async (method: string) => {
    if (method === "eth_mining" && chain.mining) return chain.mining();
    throw new Error(`unexpected RPC ${method}`);
  });
  vi.spyOn(P, "send").mockImplementation(send as never);
  wait = vi.fn(chain.wait ?? (async () => ({ blockNumber: 42 })));
  sendTransaction = vi.fn(async () => {
    if (chain.refuse) throw new Error("must not sign");
    if (chain.sendError) throw chain.sendError;
    return { hash: TX_HASH, wait };
  });
  vi.spyOn(ethers.Wallet.prototype, "sendTransaction").mockImplementation(
    sendTransaction as never,
  );
}

export const YES_ANSWERS = { password: PASSWORD, proceed: true };

export async function transfer(
  { to = TO, amount = "1.5", yes = false } = {},
  answers: Record<string, unknown> = YES_ANSWERS,
) {
  const { runWalletTransfer } = await askingCommands(answers);
  return runWalletTransfer(to, amount, { yes });
}

/** Runs the real commander action, with process.exit spied. */
export async function transferCli(
  argv: string[],
  answers: Record<string, unknown> = YES_ANSWERS,
) {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const { walletCommand } = await askingCommands(answers);
  await walletCommand.parseAsync(["transfer", ...argv], { from: "user" });
  return exit;
}

export function sentRequest(): Record<string, unknown> {
  return sendTransaction.mock.calls[0][0] as Record<string, unknown>;
}

export async function transferSetUp(): Promise<void> {
  // A port nothing listens on: every provider call is stubbed, and one
  // that slipped through must not reach a real devnet.
  writeNetworks(["local"]);
  await save("deployer");
  await use("deployer");
  clearLogged();
}
