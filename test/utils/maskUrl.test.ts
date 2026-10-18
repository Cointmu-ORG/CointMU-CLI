import { describe, expect, it } from "vitest";
import {
  maskUrl,
  maskUrlInput,
  maskUrlsInText,
  urlForHint,
} from "../../src/utils/maskUrl";
import { serverError } from "../helpers/ethersServerError";
import { inspect } from "util";

// Issue #213: saved RPC URLs can carry credentials (user:pass@, ?apikey=) and
// every command printed them in full.

const CREDS_URL = "http://user:pw@127.0.0.1:18546/rpc?k=1";
const MASKED = "http://user:***@127.0.0.1:18546/rpc?k=***";

describe("maskUrl", () => {
  it.each([
    ["user and password", CREDS_URL, MASKED],
    [
      "a lone username, often a token",
      "https://tok3n@rpc.example.com/",
      "https://***@rpc.example.com/",
    ],
    [
      "an empty username",
      "http://:pw@127.0.0.1:8585",
      "http://:***@127.0.0.1:8585",
    ],
    [
      "every query value",
      "https://rpc.example.com/v1?apikey=abc&chain=1&flag",
      "https://rpc.example.com/v1?apikey=***&chain=***&flag",
    ],
    [
      "the query but not the fragment",
      "https://rpc.example.com/?k=1#top",
      "https://rpc.example.com/?k=***#top",
    ],
    [
      "a password containing @, up to the last one before the path",
      "http://user:p@ss@127.0.0.1:8585/",
      "http://user:***@127.0.0.1:8585/",
    ],
  ])("masks %s", (_label, url, expected) => {
    expect(maskUrl(url)).toBe(expected);
  });

  it.each([
    "http://127.0.0.1:8585",
    "https://rpc.example.com:8585/path",
    "http://127.0.0.1:8585/path@not-userinfo",
    "https://rpc.example.com/#frag?not=query",
  ])("leaves %s byte for byte as it was", (url) => {
    expect(maskUrl(url)).toBe(url);
  });

  it("masks a URL that is not a valid one, as long as it has a scheme", () => {
    expect(maskUrl("ftp://user:pw@127.0.0.1:18546/rpc?k=1")).toBe(
      "ftp://user:***@127.0.0.1:18546/rpc?k=***",
    );
  });

  it("is idempotent", () => {
    expect(maskUrl(maskUrl(CREDS_URL))).toBe(MASKED);
  });
});

describe("maskUrlsInText", () => {
  it("masks a URL inside a sentence and keeps the punctuation after it", () => {
    expect(
      maskUrlsInText(
        `Pinging ${CREDS_URL}...\nRPC endpoint ${CREDS_URL} is unreachable.`,
      ),
    ).toBe(`Pinging ${MASKED}...\nRPC endpoint ${MASKED} is unreachable.`);
  });

  it("masks URLs inside quotes and brackets", () => {
    expect(
      maskUrlsInText(`invalid RPC endpoint '${CREDS_URL}'. (${CREDS_URL})`),
    ).toBe(`invalid RPC endpoint '${MASKED}'. (${MASKED})`);
  });

  it("masks the requestUrl ethers puts in its message and properties", () => {
    const error = serverError(CREDS_URL);
    const text = maskUrlsInText(inspect(error));

    expect(text).not.toContain("user:pw");
    expect(text).not.toContain("k=1");
    expect(text).toContain(`"requestUrl": "${MASKED}"`);
    expect(text).toContain(`requestUrl: '${MASKED}'`);
  });

  it("leaves text without credentials untouched", () => {
    const text =
      "RPC endpoint http://127.0.0.1:8585 is unreachable (timed out after 3000ms).";
    expect(maskUrlsInText(text)).toBe(text);
  });
});

// What `network save` was given when it is not a valid URL, which is printed
// back in the error: with no scheme there is no `://` for maskUrl() to anchor on.
describe("maskUrlInput", () => {
  it.each([
    [
      "user and password with no scheme",
      "user:pw@127.0.0.1:8545",
      "user:***@127.0.0.1:8545",
    ],
    [
      "a lone username and a query with no scheme",
      "tok3n@127.0.0.1:8545/rpc?k=1",
      "***@127.0.0.1:8545/rpc?k=***",
    ],
    [
      "a password containing @, leaving no part of it",
      "user:p@ss@127.0.0.1:8545",
      "user:***@***@127.0.0.1:8545",
    ],
    [
      "userinfo without reaching past the path",
      "user:pw@127.0.0.1:8545/p@th",
      "user:***@127.0.0.1:8545/***@th",
    ],
    [
      "a URL with a scheme the way maskUrl() does",
      "ftp://user:pw@127.0.0.1:18546/rpc?k=1",
      "ftp://user:***@127.0.0.1:18546/rpc?k=***",
    ],
  ])("masks %s", (_label, input, expected) => {
    expect(maskUrlInput(input)).toBe(expected);
  });

  it.each(["127.0.0.1:8585", "notaurl", "ws://127.0.0.1:8585"])(
    "leaves %s as it was",
    (input) => {
      expect(maskUrlInput(input)).toBe(input);
    },
  );
});

describe("urlForHint", () => {
  it("keeps a plain URL, so the hint is a command that runs as is", () => {
    expect(urlForHint("http://127.0.0.1:9000")).toBe("http://127.0.0.1:9000");
  });

  it("swaps a URL with secrets for a placeholder rather than a masked copy", () => {
    expect(urlForHint(CREDS_URL)).toBe("<url>");
  });
});
