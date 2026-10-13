/**
 * How each way out of a plugin's box is judged, every one of them (ways-out.js): by the catchers
 * alone (`egress`), where what gets out is the whole question; or, where it working would be a
 * way round the box with nothing reaching a catcher (text made into code, a way back to what the
 * worker's first lines take away, the person's clipboard, one box reaching another), by what it
 * saw too: what working looks like, and what refusing does. A way whose outcome is neither fails
 * as surely as one that worked, and a way not judged here fails the list's own test: shared by
 * the desktop's ways-out spec and the browsers'.
 */

/** Judged by what it saw: its working, and its being refused. */
interface BySaw {
  worked: RegExp
  refused: RegExp
}

export const JUDGED: Readonly<Record<string, 'egress' | BySaw>> = {
  // request
  'fetch-other': 'egress',
  'fetch-same-api': 'egress',
  'fetch-keepalive': 'egress',
  'xhr-other': 'egress',
  beacon: 'egress',
  'websocket-other': 'egress',
  'websocket-same': 'egress',
  eventsource: 'egress',
  webtransport: 'egress',
  // script
  'import-other': 'egress',
  'importScripts-other': 'egress',
  'script-tag-other': 'egress',
  eval: { worked: /^eval gave/, refused: /^threw EvalError/ },
  'new-function': { worked: /^Function gave/, refused: /^threw EvalError/ },
  'settimeout-text': { worked: /^text ran/, refused: /^text did not run$/ },
  'inline-handler': 'egress',
  // navigation
  'navigate-self-other': 'egress',
  'navigate-self-replace': 'egress',
  'navigate-self-same-api': 'egress',
  'navigate-self-within-its-path': 'egress',
  'navigate-self-data': 'egress',
  'navigate-self-javascript': 'egress',
  'meta-refresh': 'egress',
  'link-click-self': 'egress',
  'link-click-top': 'egress',
  'link-click-blank': 'egress',
  'link-ping': 'egress',
  'link-download': 'egress',
  'top-location': 'egress',
  'parent-location': 'egress',
  'window-open': 'egress',
  'history-push': 'egress',
  // form
  'form-get-other': 'egress',
  'form-post-other': 'egress',
  'form-target-blank': 'egress',
  'button-formaction': 'egress',
  'base-then-image': 'egress',
  // resource
  image: 'egress',
  'image-object': 'egress',
  'image-srcset': 'egress',
  'picture-source': 'egress',
  'svg-image': 'egress',
  'svg-use': 'egress',
  'video-poster': 'egress',
  'video-src': 'egress',
  'audio-src': 'egress',
  track: 'egress',
  'object-data': 'egress',
  'embed-src': 'egress',
  'input-image': 'egress',
  'style-url': 'egress',
  'style-tag-import': 'egress',
  'stylesheet-link': 'egress',
  'constructed-stylesheet': 'egress',
  'font-face': 'egress',
  'link-prefetch': 'egress',
  'link-preload': 'egress',
  'link-modulepreload': 'egress',
  'link-preconnect': 'egress',
  'link-dns-prefetch': 'egress',
  'link-prerender': 'egress',
  'link-icon': 'egress',
  'link-manifest': 'egress',
  'speculation-rules': 'egress',
  'csp-report': 'egress',
  // webrtc
  'webrtc-stun': 'egress',
  'webrtc-turn-tcp': 'egress',
  // built
  'worker-blob': 'egress',
  'worker-data': 'egress',
  'worker-other': 'egress',
  'shared-worker-blob': 'egress',
  'service-worker': 'egress',
  'frame-other': 'egress',
  'frame-srcdoc': 'egress',
  'frame-blob': 'egress',
  'frame-data': 'egress',
  'frame-javascript': 'egress',
  'document-write': 'egress',
  'dom-parser-then-adopt': 'egress',
  // around
  'parent-document': 'egress',
  'parent-property': 'egress',
  'top-location-read': 'egress',
  'frame-element': 'egress',
  referrer: 'egress',
  'ancestor-origins': 'egress',
  'own-origin': 'egress',
  'cookie-read': 'egress',
  'cookie-store': {
    worked: /^cookieStore has [1-9]/,
    refused: /^(no such API|threw|cookieStore has 0)/,
  },
  'local-storage': 'egress',
  'session-storage': 'egress',
  'indexed-db': 'egress',
  'cache-storage': 'egress',
  'storage-estimate': 'egress',
  'broadcast-channel': 'egress',
  'window-name': 'egress',
  'post-message-parent': 'egress',
  'post-message-top-frames': 'egress',
  // person
  alert: 'egress',
  print: 'egress',
  'clipboard-write': { worked: /^wrote/, refused: /^(no such API|refused|threw)/ },
  'clipboard-read': { worked: /^read/, refused: /^(no such API|refused|threw)/ },
  notification: {
    worked: /^answer: granted/,
    refused: /^(no such API|threw|answer: (denied|default))/,
  },
  geolocation: 'egress',
  fullscreen: 'egress',
  'pointer-lock': 'egress',
  'protocol-handler': 'egress',
  // timing
  'timer-resolution': 'egress',
  'shared-memory': 'egress',
  'resource-timing': 'egress',
  hardware: 'egress',
  'network-information': 'egress',
  // script
  'importScripts-blob': { worked: /^ran/, refused: /^(no such API|threw)/ },
  'import-blob': { worked: /^ran/, refused: /^threw/ },
  'import-data': { worked: /^ran/, refused: /^threw/ },
  'wasm-compile': { worked: /^ran/, refused: /^threw/ },
  'worker-blob-plain': { worked: /^ran/, refused: /^(threw|error event|no answer)/ },
  'back-importScripts-inherited': { worked: /^ran/, refused: /^refused/ },
  'back-own-address': { worked: /^ran/, refused: /^(refused|no such API)/ },
  'back-worker-constructor': { worked: /^ran/, refused: /^refused/ },
  'back-create-object-url': { worked: /^ran/, refused: /^refused/ },
  // request
  websocketstream: 'egress',
  'fetch-later': 'egress',
  'fetch-refused-lookup': 'egress',
  // navigation
  'mailto-navigate': 'egress',
  'mailto-link': 'egress',
  'custom-scheme-navigate': 'egress',
  'tel-link': 'egress',
  'history-back': 'egress',
  'history-go': 'egress',
  // resource
  attributionsrc: 'egress',
  fencedframe: 'egress',
  'link-preload-fetch': 'egress',
  'link-compression-dictionary': 'egress',
  'svg-feimage': 'egress',
  'svg-script': 'egress',
  'body-background': 'egress',
  'style-cursor-and-more': 'egress',
  // person
  'credentials-get': 'egress',
  'payment-request': 'egress',
  share: 'egress',
  'file-picker': 'egress',
  'take-focus': 'egress',
  'features-allowed': 'egress',
  // machine
  'secure-context': 'egress',
  'usb-devices': 'egress',
  'serial-ports': 'egress',
  'hid-devices': 'egress',
  'bluetooth-devices': 'egress',
  'webgpu-adapter': 'egress',
  'canvas-webgl-names': 'egress',
  'canvas-2d-draws': 'egress',
  'canvas-webgl-loses-context': 'egress',
  webcodecs: 'egress',
  'pressure-observer': 'egress',
  'storage-estimate-persist': 'egress',
  'user-agent-data': 'egress',
  // pair
  'pair-broadcast': { worked: /HEARD/, refused: /^first: heard nothing/ },
  'pair-locks': { worked: /SAW/, refused: /^first: (no such API|held a lock|refused)/ },
  'pair-cache': { worked: /READ/, refused: /second: (no such API|found nothing|threw)/ },
  'pair-indexeddb': { worked: /READ/, refused: /second: (threw|refused|found nothing|no event)/ },
  'pair-frames-reach': { worked: /HEARD/, refused: /^first: heard nothing/ },
  // port
  'port-flood': 'egress',
  'port-huge': 'egress',
  'port-deep': 'egress',
  spin: 'egress',
}

/**
 * Of what each way saw, those judged by it that didn't refuse: "id: what it saw" (working, or
 * neither working nor refused), for a test to expect none of.
 */
export const notRefused = (saw: Readonly<Record<string, string>>): string[] =>
  Object.entries(saw)
    .filter(([id, said]) => {
      const judged = JUDGED[id]
      return (
        judged !== undefined &&
        judged !== 'egress' &&
        (judged.worked.test(said) || !judged.refused.test(said))
      )
    })
    .map(([id, said]) => `${id}: ${said}`)
