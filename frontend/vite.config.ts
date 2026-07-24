import { defineConfig } from "vite";

// Assets are served from the same origin as the API in production. During development,
// `npm run dev` proxies `/api` to the Lean backend on port 8080.
export default defineConfig({
  base: "./",
  // React's runtime was 39.6 KB compressed — two thirds of everything that had to arrive before
  // the first paint, and more than the application's own code. Preact implements the same API in
  // 7.3 KB, and `preact/compat` maps React's module names onto it, so nothing in `src/` changes.
  //
  // The types stay React's (`@types/react`): TypeScript resolves imports itself and knows nothing
  // about these aliases, which is the documented arrangement for `preact/compat` and the reason
  // `react`/`react-dom` remain installed. Deleting this block reverts the switch.
  //
  // One behavioural difference to know about: `useDeferredValue` is a passthrough in compat, so
  // filtering happens at the same priority as the keystroke rather than below it.
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react-dom/client": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // The framework never changes between deploys, so a returning visitor re-downloads only
        // the application code.
        //
        // `marked`, `dompurify` and KaTeX are not listed: they are reached exclusively through the
        // dynamic imports in `Markdown.tsx`, so Rollup splits them out by itself and — unlike a
        // manual chunk — keeps them off the critical path entirely. Naming one here would pull it
        // back into the initial graph, which is how `marked` came to be a quarter of what had to
        // arrive before anything could be drawn.
        manualChunks: {
          preact: ["preact/compat"],
        },
      },
    },
  },
  server: {
    port: process.env.ISSUES_PORT ? parseInt(process.env.ISSUES_PORT) : undefined,
    proxy: {
      "/api": "http://localhost:8080",
      "/docs": "http://localhost:8080",
    },
  },
  preview: {
    port: process.env.ISSUES_PORT ? parseInt(process.env.ISSUES_PORT) : undefined,
  },
});
