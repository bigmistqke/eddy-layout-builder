import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig(({ mode }) => ({
  plugins: [solid({ dev: mode === "development" })],
  base: "./",
  define: {
    // vite-plugin-solid keys its dev/prod swap on process.env.NODE_ENV
    // inside its babel transform. `vite build` sets NODE_ENV to
    // "production" regardless of the --mode flag, so override here.
    "process.env.NODE_ENV": JSON.stringify(
      mode === "development" ? "development" : "production",
    ),
  },
  build: {
    // Always minify with esbuild. Solid's diagnostic strings ([STRICT_READ_UNTRACKED]
    // etc.) are literals inside the bundled dev modules and survive minification —
    // they're message *content*, not identifier names — so the test-suite console
    // match still works against the minified output.
    minify: "esbuild",
  },
  resolve: {
    // Prefer the `development` conditional export of solid-js and
    // @solidjs/* in dev builds so dev diagnostics actually emit. Vite
    // augments this with its own default conditions when undefined.
    conditions:
      mode === "development"
        ? ["development", "browser", "module", "import", "default"]
        : undefined,
  },
}))
