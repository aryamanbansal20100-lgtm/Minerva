import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"
import { AuthProvider } from "@/lib/auth"
import { SignInGate } from "@/components/SignInGate"
import LockGate from "@/components/LockGate"
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
        {/* The fingerprint lock sits INSIDE the sign-in gate: it only ever
            guards an already-signed-in account, and only on devices where the
            student turned it on. */}
        <LockGate>
          <App />
        </LockGate>
      </SignInGate>
    </AuthProvider>
  </StrictMode>,
)
