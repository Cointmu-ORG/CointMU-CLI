/**
 * The local JSON-RPC proxy both `cmu test` and `cmu node start` serve their
 * in-process Hardhat network through, and the gate in front of it.
 *
 * Hardhat's own server cannot stand in for this. As of hardhat@3.16.0 its
 * JsonRpcHandler opens `handleHttp` with `#setCorsHeaders()`, putting
 * `Access-Control-Allow-Origin: *` on every response, and never reads
 * `req.headers` at all - no Origin check, no Host check. Its `JsonRpcServerConfig`
 * is `{ hostname, port?, provider }`, so there is nothing to configure, and the
 * `node` task exposes no flag for it either. That is the state issues #83 and
 * #118 were filed about.
 *
 * Lifecycle rules it out independently: that task's `run()` resolves only once
 * the server has closed and hands back no handle to close it, while both callers
 * need one - `cmu test` to outlive the mocha run for printGasReport() and close
 * in a finally, `cmu node start` to close on SIGINT. Hence the returned server.
 */

const LOOPBACK_HOSTS = ["localhost", "::1", "[::1]", "::ffff:127.0.0.1"];

/**
 * Reports whether a bind host keeps a server reachable only from this machine.
 * @param {string} host - The host a server will bind to.
 * @returns {boolean} True for loopback addresses and localhost.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    LOOPBACK_HOSTS.includes(normalized) ||
    /^127(\.\d{1,3}){3}$/.test(normalized)
  );
}

/** Where a proxy is listening, and whether browser origins were opted in. */
export interface RpcProxyOptions {
  /** Port the proxy listens on. */
  port: number;
  /** Host the proxy binds to. */
  host: string;
  /** True when the command's `--allow-cors` was passed. */
  allowCors?: boolean;
  /** Command name quoted in the rejection message, e.g. "cmu node start". */
  command: string;
  /**
   * Clause closing the port-in-use hint, for a command that can change its port.
   * Defaults to re-running the command, which is all `cmu test` can offer.
   */
  portHint?: string;
}

/**
 * Guards a local RPC proxy against browser-originated access (DNS rebinding
 * against a localhost JSON-RPC server, issues #83 and #118).
 *
 * Node JSON-RPC clients - ethers' JsonRpcProvider, the spawned mocha process -
 * send no `Origin` header and address the host the proxy is bound to. A browser
 * always sends `Origin` on a cross-origin fetch, and a DNS-rebound request
 * carries an attacker-controlled `Host`. Either one is rejected unless the user
 * explicitly opts in with `--allow-cors`.
 *
 * The Host allowlist only applies to a loopback bind. `cmu node start --host`
 * exists so another device can reach the devnet, and such a client legitimately
 * addresses a LAN address that cannot be enumerated here - a loopback allowlist
 * would reject every one of them. The Origin check is what actually stops a
 * browser, including a rebound one, and it stays on either way; the Host check
 * is defence in depth that only means anything while the bind is loopback.
 *
 * @param {object} headers - Incoming request headers (`req.headers`).
 * @param {RpcProxyOptions} options - Where the proxy is listening.
 * @returns {boolean} True when the request may be proxied to the provider.
 */
export function isRpcRequestAllowed(
  headers: {
    origin?: string | string[];
    host?: string | string[];
  },
  options: RpcProxyOptions,
): boolean {
  if (options.allowCors) return true;

  const origin = Array.isArray(headers.origin)
    ? headers.origin[0]
    : headers.origin;
  if (origin != null && origin !== "") return false;

  if (!isLoopbackHost(options.host)) return true;

  const allowedHosts = new Set(
    ["127.0.0.1", "localhost", "[::1]", options.host.trim().toLowerCase()].map(
      (h) => `${h}:${options.port}`,
    ),
  );

  const host = Array.isArray(headers.host) ? headers.host[0] : headers.host;
  if (host != null && host !== "" && !allowedHosts.has(host.toLowerCase())) {
    return false;
  }

  return true;
}

/**
 * Minimal surface this proxy needs from a provider: Hardhat's EIP-1193 request
 * method. Narrowed so the proxy can be tested without a Hardhat runtime.
 */
export interface RpcProvider {
  request(payload: { method: string; params: unknown[] }): Promise<unknown>;
}

/**
 * Serves an in-process Hardhat network over HTTP so anything speaking JSON-RPC
 * can reach it.
 *
 * Every request passes isRpcRequestAllowed() first; see its notes for why a
 * browser-reachable JSON-RPC server needs a gate at all. Batched requests are
 * answered element by element, and a provider error is reported per element
 * rather than failing the whole batch.
 *
 * HTTP only, deliberately. Hardhat's server also speaks WebSocket on the same
 * port, which no client in this repo uses and which no same-origin policy
 * applies to - `new WebSocket()` from any page connects, so it would need its
 * own gate on the upgrade handshake to be worth keeping.
 *
 * The port is never freed on the caller's behalf: killing whatever holds it is a
 * surprising default that can take out an unrelated process, so a busy port is
 * reported instead (issue #115).
 *
 * @param {RpcProvider} provider - The provider to forward calls to.
 * @param {RpcProxyOptions} options - Where to listen, and the gate's settings.
 * @returns {Promise<any>} The listening http.Server.
 * @throws {Error} If the port is already in use, or the bind fails otherwise.
 */
export async function startRpcProxy(
  provider: RpcProvider,
  options: RpcProxyOptions,
): Promise<any> {
  const http = require("http");
  const allowCors = Boolean(options.allowCors);

  const server = http.createServer((req: any, res: any) => {
    let body = "";
    req.on("data", (chunk: any) => {
      body += chunk.toString();
    });
    req.on("end", async () => {
      if (!isRpcRequestAllowed(req.headers, options)) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json");
        return res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: {
              code: -32600,
              message:
                "Forbidden: cross-origin or non-local request rejected. " +
                `Pass --allow-cors to ${options.command} to allow browser access.`,
            },
          }),
        );
      }
      if (req.method === "OPTIONS") {
        if (allowCors) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.setHeader("Access-Control-Allow-Headers", "*");
          res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
          res.statusCode = 204;
        } else {
          res.statusCode = 403;
        }
        return res.end();
      }
      if (!body) {
        res.statusCode = 400;
        return res.end();
      }
      try {
        const json = JSON.parse(body);
        const isArray = Array.isArray(json);
        const reqs = isArray ? json : [json];
        const responses = [];

        for (const r of reqs) {
          try {
            const result = await provider.request({
              method: r.method,
              params: r.params || [],
            });
            responses.push({ jsonrpc: "2.0", id: r.id, result });
          } catch (error: any) {
            responses.push({
              jsonrpc: "2.0",
              id: r.id,
              error: { code: error.code || -32603, message: error.message },
            });
          }
        }

        res.setHeader("Content-Type", "application/json");
        if (allowCors) res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(JSON.stringify(isArray ? responses : responses[0]));
      } catch {
        res.statusCode = 400;
        res.end(
          `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}`,
        );
      }
    });
  });

  // listen()'s callback is a one-shot 'listening' listener; Node never passes it
  // an error. A bind failure arrives as an 'error' event, and with no listener
  // for it that is an uncaught exception - the reason a busy port used to print
  // a raw stack trace instead of going through fail() (issue #115).
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  }).catch((error: any) => {
    if (error?.code !== "EADDRINUSE") throw error;
    const retry = options.portHint ?? `then run \`${options.command}\` again`;
    throw new Error(
      `port ${options.port} is already in use.\n` +
        `\x1b[2mhint:\x1b[0m stop the process using it, ${retry}.`,
    );
  });

  return server;
}
