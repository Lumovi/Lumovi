- A server acts for someone signed in only on requests that say they come from Lumovi's own page.
  Where their browser sends Sec-Fetch-Site as they sign in, every later request of that session
  must send it as same-origin; any other is refused, and changes nothing of the session. A
  browser that doesn't send it as they sign in isn't held to it. `LUMOVI_SEC_FETCH_SITE=off`
  turns it off. A setting that should be an address and isn't is no longer repeated in its error.
