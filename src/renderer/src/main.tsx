import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// Lets CSS leave room for the native window controls of each platform (none in full screen).
document.documentElement.dataset.platform = window.kubestacks.platform
window.kubestacks.onFullScreen((fullScreen) =>
  document.documentElement.toggleAttribute('data-fullscreen', fullScreen),
)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
