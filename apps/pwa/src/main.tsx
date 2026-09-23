import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './app/App'
import './app/fonts.css'
import './app/styles.css'
import './app/responsive-media.css'

// Keep browser page scale fixed; map gestures are handled by the map itself.
for (const eventName of ['gesturestart', 'gesturechange']) {
  document.addEventListener(eventName, event => event.preventDefault(), { passive: false })
}
document.addEventListener('touchmove', event => {
  if (event.touches.length > 1) event.preventDefault()
}, { passive: false })

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
