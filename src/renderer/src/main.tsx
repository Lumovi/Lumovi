// With its optical sizes: larger text gets Inter's display cut, as the brand's headlines do.
import '@fontsource-variable/inter/opsz.css'
import '@fontsource-variable/jetbrains-mono'
import './styles/index.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { api } from './lib/api'
import { keepFocusOnRedrawn } from './lib/focus-back'

// Lets CSS leave room for the desktop app's window controls: macOS's on the left (none in full
// screen), others' on the right. A browser has its own, around the page.
document.documentElement.dataset.windowControls =
  api.host === 'server' ? 'none' : api.platform === 'darwin' ? 'left' : 'right'
api.desktop?.onFullScreen((fullScreen) =>
  document.documentElement.toggleAttribute('data-fullscreen', fullScreen),
)

// Where it runs: a server's page can be narrower than the desktop app's window ever is.
document.documentElement.dataset.host = api.host

// A plugin's sealed box, and the stage a plugin's page is drawn on, are reached by the tests
// alone so far (`plugins/box.ts`, `plugins/stage.tsx`): nothing in Lumovi shows a plugin's page
// yet, and a release build has none of it.
declare const LUMOVI_TEST_BUILD: boolean
if (LUMOVI_TEST_BUILD) {
  void import('./plugins/box').then(({ openBox, openBoxBare }) => {
    ;(window as unknown as { __lumoviBox: unknown }).__lumoviBox = { openBox, openBoxBare }
  })
  void import('./plugins/stage').then(({ stage }) => {
    ;(window as unknown as { __lumoviDoor: unknown }).__lumoviDoor = stage
  })
}

// The keyboard stays on a button drawn anew in its place: busy once its change is made, and back.
keepFocusOnRedrawn()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
