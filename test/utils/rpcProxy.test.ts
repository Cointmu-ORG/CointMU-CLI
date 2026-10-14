import { describe, expect, it } from "vitest";
import { isLoopbackHost, isRpcRequestAllowed } from "../../src/utils/rpcProxy";

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
