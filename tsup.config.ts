import { defineConfig } from "tsup";
import { execSync } from "child_process";

// Stamped into the bundle so `cmu version` can identify a build. Resolved from
// git rather than a generated file that had to be committed on every release.
// A published tarball has no .git, but it is also never rebuilt from there.
let buildId = "unknown";
try {
  buildId = execSync("git rev-parse --short HEAD", { stdio: "pipe" })
    .toString()
    .trim();
} catch {
  // not a git checkout, ship "unknown"
}

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["cjs"],
  outDir: "dist",
  target: "node20",
  minify: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  shims: true,
  define: {
    __CMU_BUILD_ID__: JSON.stringify(buildId),
  },
});
