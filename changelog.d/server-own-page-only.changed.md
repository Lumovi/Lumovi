- A server acts for someone signed in only on requests that say they come from Lumovi's own page.
  Where their browser sends Sec-Fetch-Site as they sign in, every later request of that session must
  send it as same-origin; any other is refused, and changes nothing of the session. A browser that
  doesn't send it as they sign in isn't held to it. `LUMOVI_SEC_FETCH_SITE=off` (the chart's
  `auth.secFetchSite`) turns it off. Behind a sign-in proxy, `LUMOVI_PROXY_SEC_FETCH_SITE=on` (the
  chart's `auth.proxy.secFetchSite`) says the proxy passes the header through unchanged: every
  request is then held to it, and one without it is refused. Off, the default, plugins that run code
  aren't offered behind a proxy. A setting that should be an address and isn't is no longer repeated
  in its error.
