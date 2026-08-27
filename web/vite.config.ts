import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    // "@/components/ui/..." — the import style every shadcn component uses.
    alias: { "@": new URL("./src", import.meta.url).pathname },
  },
  server: {
    port: 5173,
    // The Python server keeps the API keys and the database. React never talks
    // to Groq or Gemini directly; it calls our own /api and the proxy forwards.
    // /s and /share-open.js are the public share routes, also Python-served, so
    // a share link opened during local dev works instead of hitting the SPA.
    proxy: {
      "/api": { target: "http://localhost:7400", changeOrigin: true },
      // Anchored regexes, NOT "/s" — a bare prefix key also matches /src/main.tsx
      // and every other path beginning with s, which takes the dev server down.
      "^/s/[A-Za-z0-9_-]+": { target: "http://localhost:7400", changeOrigin: true },
      "^/share-open\\.js$": { target: "http://localhost:7400", changeOrigin: true },
    },
  },
})
