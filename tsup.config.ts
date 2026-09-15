import { defineConfig } from "tsup";
import fs from "fs";

let buildId = "unknown";
try {
  buildId = JSON.parse(fs.readFileSync("build-info.json", "utf-8")).build;
} catch {
  // no build-info.json yet, ship "unknown"
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
