import { expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

// well-known Ganache test key — never fund this
export const PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
export const SESSION_PASSWORD = "correct horse";
export const ADDRESS = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
];

/** Every file under dir, recursively. */
export function allFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

/**
 * The signer's key, with or without 0x, is nowhere in texts (what was printed,
 * errors thrown) or in any file under dir (HOME and the project).
 */
export function expectNoKeyLeak(texts: string[], dir: string): void {
  const haystacks = [
    texts.join("\n"),
    ...allFiles(dir).map((f) => fs.readFileSync(f, "utf8")),
  ].map((t) => t.toLowerCase());
  for (const secret of [PRIVATE_KEY, PRIVATE_KEY.slice(2)]) {
    for (const text of haystacks) {
      expect(text).not.toContain(secret.toLowerCase());
    }
  }
}
