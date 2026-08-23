import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { AuthProvider } from "@/lib/auth"
import { SignInGate } from "@/components/SignInGate"
import SplashLogo from "@/components/SplashLogo"

// Follow the OS theme, matching the rest of the app.
if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.documentElement.classList.add("dark")
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      {/* An overlay, deliberately outside SignInGate: the app mounts and starts
          fetching behind the animation, so the splash costs no time at all. */}
      <SplashLogo />
      <SignInGate>
        <App />
      </SignInGate>
    </AuthProvider>
  </StrictMode>,
)
