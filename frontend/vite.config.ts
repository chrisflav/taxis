import { defineConfig } from "vite";

// Assets are served from the same origin as the API in production. During development,
// `npm run dev` proxies `/api` to the Lean backend on port 8080.
export default defineConfig({
  base: "./",
  build: {
    outDir: "dist",
    rollupOptions: {
      output: {
        // Keep React in its own chunk: it never changes between deploys, so a returning visitor
        // re-downloads only the application code. KaTeX is already split out by the dynamic
        // import in `Markdown.tsx`.
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
