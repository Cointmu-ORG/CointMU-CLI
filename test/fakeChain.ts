import { keccak256 } from "ethers";

/**
 * An in-memory chain behind the handful of provider calls the deployment
 * recorder makes. One transaction per block, like the automining devnet.
 */
export class FakeChain {
  chainId = 1912n;
  blocks: { number: number; timestamp: number; txs: any[] }[] = [
    { number: 0, timestamp: 1_700_000_000, txs: [] },
  ];
  receipts = new Map<string, any>();
  code = new Map<string, string>();
  nonces = new Map<string, number>();
  /** Every provider method called, by name. */
  calls: string[] = [];
  private counter = 0;

  private mine(tx: any, receipt: any): void {
    const number = this.blocks.length;
    this.blocks.push({ number, timestamp: 1_700_000_000 + number, txs: [tx] });
    this.receipts.set(tx.hash, receipt);
    const from = tx.from.toLowerCase();
    this.nonces.set(from, (this.nonces.get(from) ?? 0) + 1);
  }

  private next(): string {
    this.counter++;
    return this.counter.toString(16).padStart(40, "0");
  }

  /** A contract creation (`to` null) sent by `from`; returns its address. */
  create(from: string, data: string, runtime = "0x6080"): string {
    const address = `0x${this.next()}`;
    const hash = `0x${this.next().padStart(64, "0")}`;
    this.code.set(address, runtime);
    this.mine(
      { hash, from, to: null, data },
      { contractAddress: address, status: 1 },
    );
    return address;
  }

  /**
   * A call to `to` that, like a factory, creates a contract internally: the
   * code exists, but the receipt names no contractAddress.
   */
  factoryCreate(from: string, to: string, runtime = "0x6080"): string {
    const address = `0x${this.next()}`;
    const hash = `0x${this.next().padStart(64, "0")}`;
    this.code.set(address, runtime);
    this.mine(
      { hash, from, to, data: "0x" },
      { contractAddress: null, status: 1 },
    );
    return address;
  }

  provider(): any {
    const log = (name: string) => this.calls.push(name);
    return {
      getNetwork: async () => (log("getNetwork"), { chainId: this.chainId }),
      getBlockNumber: async () => (
        log("getBlockNumber"),
        this.blocks.length - 1
      ),
      getTransactionCount: async (a: string) => (
        log("getTransactionCount"),
        this.nonces.get(a.toLowerCase()) ?? 0
      ),
      getBlock: async (n: number, prefetch: boolean) => {
        log("getBlock");
        const b = this.blocks[n];
        return b && { ...b, prefetchedTransactions: prefetch ? b.txs : [] };
      },
      getTransactionReceipt: async (h: string) => (
        log("getTransactionReceipt"),
        this.receipts.get(h) ?? null
      ),
      getCode: async (a: string) => (log("getCode"), this.code.get(a) ?? "0x"),
      destroy: () => log("destroy"),
    };
  }
}

export const hashOf = (code: string) => keccak256(code);
