import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Assets are served from the same origin as the API in production. During development,
// `npm run dev` proxies `/api` to the Lean backend on port 8080.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { outDir: "dist" },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/docs": "http://localhost:8080",
    },
  },
});
