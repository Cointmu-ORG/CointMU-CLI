import { existsSync, readFileSync } from "fs";
import * as path from "path";

/** The fields of the CLI's own package.json that the CLI prints. */
export interface Pkg {
  version: string;
  codename: string;
  description: string;
}

const UNKNOWN_PKG: Pkg = {
  version: "unknown",
  codename: "unknown",
  description: "",
};

/**
 * The CLI's own package.json, or "unknown" placeholders when it cannot be read.
 *
 * Found by walking up from __dirname rather than at a fixed "..": bundled, this
 * runs from dist/index.js, one level below the package root, but under vitest
 * and ts-node it runs from src/utils/, two levels below.
 *
 * @returns {Pkg} The parsed package.json.
 */
export function readPkg(): Pkg {
  let dir = __dirname;
  while (!existsSync(path.join(dir, "package.json"))) {
    if (dir === path.dirname(dir)) return UNKNOWN_PKG;
    dir = path.dirname(dir);
  }
  try {
    return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return UNKNOWN_PKG;
  }
}
