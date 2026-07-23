import { defineConfig } from "vite";

// Assets are served from the same origin as the API in production. During development,
// `npm run dev` proxies `/api` to the Lean backend on port 8080.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // React never changes between deploys, so a returning visitor re-downloads only the
        // application code.
        //
        // `marked`, `dompurify` and KaTeX are not listed: they are reached exclusively through the
        // dynamic imports in `Markdown.tsx`, so Rollup splits them out by itself and — unlike a
        // manual chunk — keeps them off the critical path entirely. Naming one here would pull it
        // back into the initial graph, which is how `marked` came to be a quarter of what had to
        // arrive before anything could be drawn.
        manualChunks: {
          react: ["react", "react-dom", "react-dom/client"],
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
