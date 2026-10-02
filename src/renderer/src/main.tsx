import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './lib/api'

// Lets CSS leave room for the desktop app's window controls: macOS's on the left (none in full
// screen), others' on the right. A browser has its own, around the page.
document.documentElement.dataset.windowControls =
  api.host === 'server' ? 'none' : api.platform === 'darwin' ? 'left' : 'right'
api.desktop?.onFullScreen((fullScreen) =>
  document.documentElement.toggleAttribute('data-fullscreen', fullScreen),
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
