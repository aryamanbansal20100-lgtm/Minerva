import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { AuthProvider } from "@/lib/auth"
import { SignInGate } from "@/components/SignInGate"

// Follow the OS theme, matching the rest of the app.
if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark")
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <SignInGate>
        <App />
      </SignInGate>
    </AuthProvider>
  </StrictMode>,
)
