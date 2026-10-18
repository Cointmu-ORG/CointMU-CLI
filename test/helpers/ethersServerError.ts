/**
 * The error ethers 6.17.0 throws when an RPC endpoint answers HTTP 401, as
 * captured from a real JsonRpcProvider against a local stub (#213). ethers
 * folds `info` into the message, so the request URL - credentials and all - is
 * in the plain message, not only in what --verbose inspects.
 *
 * @param {string} url - The URL the provider was created with.
 * @returns {Error} An error shaped like the captured one.
 */
export function serverError(url: string): Error {
  const info = {
    requestUrl: url,
    responseBody: "unauthorized",
    responseStatus: "401 Unauthorized",
  };
  return Object.assign(
    new Error(
      `server response 401 Unauthorized (request={  }, response={  }, error=null, info=${JSON.stringify(info, null, 1).replace(/\n */g, " ")}, code=SERVER_ERROR, version=6.17.0)`,
    ),
    {
      code: "SERVER_ERROR",
      request: {},
      response: {},
      error: undefined,
      info,
      shortMessage: "server response 401 Unauthorized",
    },
  );
}
