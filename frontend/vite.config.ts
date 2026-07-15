import { defineConfig } from "vite";

// Assets are served from the same origin as the API in production. During development,
// `npm run dev` proxies `/api` to the Lean backend on port 8080.
export default defineConfig({
  base: "./",
  build: { outDir: "dist" },
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
