import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isRpcRequestAllowed, startRpcProxy } from "../../src/commands/test";

describe("isRpcRequestAllowed", () => {
  it("allows a bare loopback request with no Origin (ethers JsonRpcProvider)", () => {
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8555" })).toBe(true);
  });

  it("allows localhost and IPv6 loopback hosts, case-insensitively", () => {
    expect(isRpcRequestAllowed({ host: "localhost:8555" })).toBe(true);
    expect(isRpcRequestAllowed({ host: "LOCALHOST:8555" })).toBe(true);
    expect(isRpcRequestAllowed({ host: "[::1]:8555" })).toBe(true);
  });

  it("allows a request with no Host header at all", () => {
    expect(isRpcRequestAllowed({})).toBe(true);
  });

  it("rejects any request that carries an Origin header (browser fetch/XHR)", () => {
    expect(
      isRpcRequestAllowed({
        host: "127.0.0.1:8555",
        origin: "http://evil.example",
      }),
    ).toBe(false);
    expect(
      isRpcRequestAllowed({ host: "127.0.0.1:8555", origin: "null" }),
    ).toBe(false);
  });

  it("rejects a foreign Host header (DNS rebinding)", () => {
    expect(isRpcRequestAllowed({ host: "attacker.example" })).toBe(false);
    expect(isRpcRequestAllowed({ host: "attacker.example:8555" })).toBe(false);
    expect(isRpcRequestAllowed({ host: "127.0.0.1:9999" })).toBe(false);
  });

  it("handles header values delivered as arrays", () => {
    expect(isRpcRequestAllowed({ host: ["127.0.0.1:8555"] })).toBe(true);
    expect(
      isRpcRequestAllowed({ host: ["127.0.0.1:8555"], origin: ["http://x"] }),
    ).toBe(false);
  });

  it("bypasses every check when --allow-cors is opted in", () => {
    expect(
      isRpcRequestAllowed(
        { host: "attacker.example", origin: "http://evil.example" },
        true,
      ),
    ).toBe(true);
  });
});

// The proxy is how the spawned mocha run reaches the in-process Hardhat
// network, and the only thing standing between a browser and that network.
// It used to be buried inside runTest(); these drive it directly.

const PROXY_PORT = 8555; // TEST_PORT: the Host allowlist is pinned to it
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

describe("startRpcProxy", () => {
  let server: any;
  let requests: { method: string; params: unknown[] }[];

  async function listen(options: { allowCors?: boolean } = {}) {
    requests = [];
    const provider = {
      request: async (payload: { method: string; params: unknown[] }) => {
        requests.push(payload);
        if (payload.method === "eth_explode") {
          throw Object.assign(new Error("boom"), { code: -32000 });
        }
        return `ok:${payload.method}`;
      },
    };
    server = await startRpcProxy(provider, options);
  }

  function rpc(body: unknown, headers: Record<string, string> = {}) {
    return fetch(PROXY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server.close(() => r()));
    server = undefined;
    vi.restoreAllMocks();
  });

  it("forwards a single call and wraps the result in a JSON-RPC envelope", async () => {
    await listen();

    const res = await rpc({ jsonrpc: "2.0", id: 7, method: "eth_chainId" });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: "ok:eth_chainId",
    });
    expect(requests).toEqual([{ method: "eth_chainId", params: [] }]);
  });

  it("answers a batch element by element, keeping ids aligned", async () => {
    await listen();

    const res = await rpc([
      { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [1] },
      { jsonrpc: "2.0", id: 2, method: "eth_chainId" },
    ]);

    await expect(res.json()).resolves.toEqual([
      { jsonrpc: "2.0", id: 1, result: "ok:eth_blockNumber" },
      { jsonrpc: "2.0", id: 2, result: "ok:eth_chainId" },
    ]);
  });

  it("reports a provider failure per element instead of failing the batch", async () => {
    await listen();

    const res = await rpc([
      { jsonrpc: "2.0", id: 1, method: "eth_explode" },
      { jsonrpc: "2.0", id: 2, method: "eth_chainId" },
    ]);

    await expect(res.json()).resolves.toEqual([
      { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "boom" } },
      { jsonrpc: "2.0", id: 2, result: "ok:eth_chainId" },
    ]);
  });

  it("rejects a browser-originated request with 403 and never reaches the provider", async () => {
    await listen();

    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { Origin: "http://evil.example" },
    );

    expect(res.status).toBe(403);
    expect(requests).toEqual([]);
  });

  it("serves the preflight only once --allow-cors is opted in", async () => {
    await listen({ allowCors: true });

    const res = await fetch(PROXY_URL, {
      method: "OPTIONS",
      headers: { Origin: "http://app.example" },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("answers 400 on an empty body and -32700 on malformed JSON", async () => {
    await listen();

    const empty = await fetch(PROXY_URL, { method: "POST" });
    expect(empty.status).toBe(400);

    const broken = await rpc("{not json");
    expect(broken.status).toBe(400);
    await expect(broken.json()).resolves.toMatchObject({
      error: { code: -32700 },
    });
  });
});

describe("printGasReport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("totals the gas of every receipt it finds", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getBlockNumber = async () => 1;
          getBlock = async () => ({ transactions: ["0xdead", "0xbeef"] });
          getTransactionReceipt = async () => ({ gasUsed: 21000n });
        },
      },
    }));
    const { printGasReport: report } = await import("../../src/commands/test");

    await report(8555);

    const output = (log as any).mock.calls.flat().join("\n");
    expect(output).toContain("Gas profile");
    expect(output).toContain("0xdead");
    expect(output).toContain("Total gas used: 42000");
  });

  it("downgrades its own failure to a warning so the test result stands", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.doMock("ethers", () => ({
      ethers: {
        JsonRpcProvider: class {
          getBlockNumber = async () => {
            throw new Error("devnet already gone");
          };
        },
      },
    }));
    const { printGasReport: report } = await import("../../src/commands/test");

    await expect(report(8555)).resolves.toBeUndefined();

    const output = (error as any).mock.calls.flat().join("\n");
    expect(output).toContain("warning:");
    expect(output).toContain("could not produce the gas report");
  });
});
