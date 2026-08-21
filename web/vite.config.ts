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
    proxy: { "/api": { target: "http://localhost:7400", changeOrigin: true } },
  },
})
