import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isLoopbackHost,
  isRpcRequestAllowed,
  startRpcProxy,
} from "../../src/utils/rpcProxy";

// Issue #86 (b): binding to a non-loopback host exposes the RPC endpoint and
// the private keys `cmu node start` prints.
describe("isLoopbackHost", () => {
  it.each(["127.0.0.1", "127.0.0.2", "localhost", "LOCALHOST", "::1", "[::1]"])(
    "treats %s as loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(true);
    },
  );

  it.each(["0.0.0.0", "192.168.1.10", "::", "example.local"])(
    "treats %s as non-loopback",
    (host) => {
      expect(isLoopbackHost(host)).toBe(false);
    },
  );
});

// Issues #83 (cmu test) and #118 (cmu node start): a browser-reachable
// localhost JSON-RPC server is a DNS-rebinding target. Both commands serve
// through this gate, on different ports and - for node start - a settable host,
// so every case below pins which configuration it is describing.
describe("isRpcRequestAllowed", () => {
  const TEST = { port: 8555, host: "127.0.0.1", command: "cmu test" };
  const NODE = { port: 8585, host: "127.0.0.1", command: "cmu node start" };
  const LAN = { port: 8585, host: "0.0.0.0", command: "cmu node start" };

  it("allows a bare loopback request with no Origin (ethers JsonRpcProvider)", () => {
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8555" }, TEST)).toBe(true);
  });

  it("allows localhost and IPv6 loopback hosts, case-insensitively", () => {
    expect(isRpcRequestAllowed({ host: "localhost:8555" }, TEST)).toBe(true);
    expect(isRpcRequestAllowed({ host: "LOCALHOST:8555" }, TEST)).toBe(true);
    expect(isRpcRequestAllowed({ host: "[::1]:8555" }, TEST)).toBe(true);
  });

  it("allows a request with no Host header at all", () => {
    expect(isRpcRequestAllowed({}, TEST)).toBe(true);
  });

  it("rejects any request that carries an Origin header (browser fetch/XHR)", () => {
    expect(
      isRpcRequestAllowed(
        { host: "127.0.0.1:8555", origin: "http://evil.example" },
        TEST,
      ),
    ).toBe(false);
    expect(
      isRpcRequestAllowed({ host: "127.0.0.1:8555", origin: "null" }, TEST),
    ).toBe(false);
  });

  it("rejects a foreign Host header (DNS rebinding)", () => {
    expect(isRpcRequestAllowed({ host: "attacker.example" }, TEST)).toBe(false);
    expect(isRpcRequestAllowed({ host: "attacker.example:8555" }, TEST)).toBe(
      false,
    );
    expect(isRpcRequestAllowed({ host: "127.0.0.1:9999" }, TEST)).toBe(false);
  });

  it("pins the Host allowlist to the port it was given", () => {
    // The two commands listen on different ports; neither may accept the other's.
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8585" }, NODE)).toBe(true);
    expect(isRpcRequestAllowed({ host: "localhost:8585" }, NODE)).toBe(true);
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8555" }, NODE)).toBe(false);
    expect(isRpcRequestAllowed({ host: "127.0.0.1:8585" }, TEST)).toBe(false);
  });

  it("stops checking Host once the bind is not loopback, but never Origin", () => {
    // `cmu node start --host 0.0.0.0` exists so another device can reach the
    // DevNet; such a client addresses a LAN address we cannot enumerate, so a
    // loopback allowlist would reject all of them. Origin is what stops a
    // browser, rebound or not, and it still applies.
    expect(isRpcRequestAllowed({ host: "192.168.1.10:8585" }, LAN)).toBe(true);
    expect(isRpcRequestAllowed({ host: "attacker.example" }, LAN)).toBe(true);
    expect(
      isRpcRequestAllowed(
        { host: "192.168.1.10:8585", origin: "http://evil.example" },
        LAN,
      ),
    ).toBe(false);
  });

  it("handles header values delivered as arrays", () => {
    expect(isRpcRequestAllowed({ host: ["127.0.0.1:8555"] }, TEST)).toBe(true);
    expect(
      isRpcRequestAllowed(
        { host: ["127.0.0.1:8555"], origin: ["http://x"] },
        TEST,
      ),
    ).toBe(false);
  });

  it("bypasses every check when --allow-cors is opted in", () => {
    expect(
      isRpcRequestAllowed(
        { host: "attacker.example", origin: "http://evil.example" },
        { ...TEST, allowCors: true },
      ),
    ).toBe(true);
  });
});

// The proxy is how the spawned mocha run reaches the in-process Hardhat
// network, and the only thing standing between a browser and the DevNet.

const PROXY_PORT = 8555;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;

describe("startRpcProxy", () => {
  let server: any;
  let requests: { method: string; params: unknown[] }[];

  async function listen(
    options: { allowCors?: boolean; command?: string } = {},
  ) {
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
    server = await startRpcProxy(provider, {
      port: PROXY_PORT,
      host: "127.0.0.1",
      command: "cmu test",
      ...options,
    });
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

  it("names the command that owns the proxy in its rejection", async () => {
    await listen({ command: "cmu node start" });

    const res = await rpc(
      { jsonrpc: "2.0", id: 1, method: "eth_chainId" },
      { Origin: "http://evil.example" },
    );

    await expect(res.json()).resolves.toMatchObject({
      error: {
        code: -32600,
        message: expect.stringContaining("--allow-cors to cmu node start"),
      },
    });
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

// Issue #115: killPort() used to "free" the port first, which outside Windows
// meant printing "Port N is free." and binding anyway. Nothing is killed now,
// so a busy port has to say so itself - and reach fail(), which it could not
// while a bind error was an uncaught 'error' event rather than a rejection.
describe("startRpcProxy on a port that is taken", () => {
  const provider = { request: async () => "ok" };
  let squatter: any;

  beforeEach(async () => {
    const http = require("http");
    squatter = http.createServer(() => {});
    await new Promise<void>((resolve) =>
      squatter.listen(PROXY_PORT, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => squatter.close(() => resolve()));
  });

  it("reports the busy port and how to retry the command that hit it", async () => {
    const error = await startRpcProxy(provider, {
      port: PROXY_PORT,
      host: "127.0.0.1",
      command: "cmu test",
    }).catch((e: Error) => e);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`port ${PROXY_PORT} is already in use`);
    expect(message).toContain("hint:");
    expect(message).toContain("`cmu test` again");
    // The misleading line the issue was filed about.
    expect(message).not.toContain("is free");
  });

  it("points `cmu node start` at -p, which is the port it can change", async () => {
    const error = await startRpcProxy(provider, {
      port: PROXY_PORT,
      host: "127.0.0.1",
      command: "cmu node start",
      portHint: "or run `cmu node start` with a different -p",
    }).catch((e: Error) => e);

    expect((error as Error).message).toContain(
      "or run `cmu node start` with a different -p",
    );
  });
});

it("rejects other bind failures instead of crashing the process", async () => {
  // Not EADDRINUSE, so it must surface as itself rather than as a port clash.
  // Before the 'error' listener existed this took the worker down outright.
  const error = await startRpcProxy(
    { request: async () => "ok" },
    { port: 8555, host: "203.0.113.1", command: "cmu test" },
  ).catch((e: any) => e);

  expect(error).toBeInstanceOf(Error);
  expect(error.code).toMatch(/EADDRNOTAVAIL|EINVAL|EACCES/);
  expect(error.message).not.toContain("already in use");
});
