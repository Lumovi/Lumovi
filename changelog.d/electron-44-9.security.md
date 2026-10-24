- **The desktop app runs on Electron 44.9.3**, with Chromium 152.0.7977.167 and the fixes Electron
  has backported from Chromium, V8 and the libraries they use since 44.7.2, and with Electron's
  mitigation for the compromised eMudhra intermediate certificates (GHSA-jr5w-w6x2-84p9). Lumovi
  in your cluster doesn't run on Electron, and is unchanged by it.
