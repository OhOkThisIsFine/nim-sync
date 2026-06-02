import { build } from "esbuild";

await build({
  entryPoints: {
    server: "src/plugin/opencode-server.ts",
    tui: "src/plugin/opencode-tui.ts",
  },
  outdir: "dist",
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  outExtension: {
    ".js": ".mjs",
  },
  sourcemap: true,
  legalComments: "eof",
});
