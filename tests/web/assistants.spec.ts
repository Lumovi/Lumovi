/**
 * AI assistants on a Lumovi server: they sign in as someone with OAuth, as MCP
 * clients do (the MCP SDK's own client plays the assistant here), read the
 * clusters that person can, and the changes they ask for wait on the person's
 * own pages.
 */
import type { BrowserContext, Page } from '@playwright/test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Assistant, call, callback, connect } from './assistant-client.ts'
import { audited, DEMO, expect, PEOPLE, refusedConfig, signIn, test } from './fixtures.ts'

/** What a change came to: waiting for it again while the assistant is told to (slow machines). */
async function outcome(client: Client, asked: Promise<{ text: string }>): Promise<string> {
  let { text } = await asked
  for (let id; text.startsWith('Still waiting') && (id = text.match(/id “([\w-]+)”/)?.[1]);) {
    ;({ text } = await call(client, 'wait_for_change', { id }))
  }
  return text
}

const approval = (page: Page, title: string | RegExp) => page.getByRole('dialog', { name: title })

/** The browser's notifications, recorded (window.__notices), with the permission `permission` gives. */
async function fakeNotifications(context: BrowserContext, permission = 'default') {
  await context.addInitScript((permission) => {
    const notices: { title: string; body?: string }[] = []
    Object.assign(window, { __notices: notices })
    class Recorded {
      static permission = permission
      static async requestPermission() {
        Recorded.permission = 'granted'
        return 'granted'
      }
      onclick: (() => void) | null = null
      constructor(title: string, options?: { body?: string }) {
        notices.push({ title, body: options?.body })
        Object.assign(window, { __lastNotice: this })
      }
    }
    Object.assign(window, { Notification: Recorded })
  }, permission)
}

test('assistants sign in as the person, and read what they may', async ({
  page,
  serve,
  clusters,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  expect(served.log()).toContain(
    'alice@example.com allowed Claude Code (lumovi) to use Lumovi as them',
  )

  // The clusters she sees, as her.
  expect((await call(client, 'list_clusters')).text).toMatch(
    /^current: demo\nclusters:\n {2}- name: demo\n/,
  )
  const pods = await call(client, 'list_resources', {
    cluster: 'demo',
    kind: 'pods',
    namespace: 'shop',
  })
  expect(pods.text).toContain(DEMO.pods.storefront[0]!)
  expect(clusters.demo.requests.at(-1)?.user).toBe('alice@example.com')

  // Her assistants, by the names they give.
  await page.goto(`${served.url}cluster/demo`)
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  const dialog = page.getByRole('main')
  await expect(page.getByRole('link', { name: /^Your assistants\s*1$/ })).toBeVisible()
  await expect(dialog.getByLabel('Command', { exact: true })).toHaveText(
    `claude mcp add --transport http lumovi ${served.url}mcp`,
  )
  // Codex signs in with OAuth as it's added (checked with Codex 0.161).
  await dialog.getByRole('tab', { name: 'Codex' }).click()
  await expect(dialog.getByLabel('Command', { exact: true })).toHaveText(
    `codex mcp add lumovi --url ${served.url}mcp`,
  )
  await dialog.getByRole('tab', { name: 'Cursor' }).click()
  const cursor = new URL(
    (await dialog.getByRole('link', { name: 'Add to Cursor' }).getAttribute('href'))!,
  )
  expect(JSON.parse(atob(cursor.searchParams.get('config')!))).toEqual({ url: `${served.url}mcp` })
  await dialog.getByRole('tab', { name: 'VS Code' }).click()
  const vscode = (await dialog.getByRole('link', { name: 'Add to VS Code' }).getAttribute('href'))!
  expect(JSON.parse(decodeURIComponent(vscode.slice('vscode:mcp/install?'.length)))).toEqual({
    name: 'lumovi',
    type: 'http',
    url: `${served.url}mcp`,
  })
  await dialog.getByRole('tab', { name: 'Other' }).click()
  await expect(dialog.getByLabel('Address', { exact: true })).toHaveText(`${served.url}mcp`)
  await page.getByRole('link', { name: /^Your assistants/ }).click()
  const yours = dialog.getByRole('region', { name: 'Your assistants' })
  await expect(yours.getByRole('listitem')).toHaveText([
    /^Claude CodeAllowed \d+s ago · used \d+s ago/,
  ])

  // Let go, it can't act as her any more.
  await yours.getByRole('button', { name: 'Disconnect' }).click()
  await expect(yours).toContainText('None yet')
  await expect(call(client, 'list_clusters')).rejects.toThrow()
  expect(served.log()).toContain('alice@example.com’s Claude Code was let go')

  // The audit log: allowed by her, from her page; what it called, as her, through it; let go.
  expect(audited(served, 'assistant.allowed')).toEqual([
    expect.objectContaining({
      outcome: 'success',
      summary: 'Allowed Claude Code (lumovi) to use Lumovi as them',
      actor: expect.objectContaining({ user: 'alice@example.com', via: 'ui' }),
      details: expect.objectContaining({ assistant: 'Claude Code (lumovi)' }),
    }),
  ])
  const tools = audited(served, 'assistant.tool')
  expect(tools.map((e) => [e.summary, e.outcome, e.cluster])).toEqual([
    ['List clusters', 'success', undefined],
    ['List resources', 'success', 'demo'],
  ])
  expect(tools[1]).toMatchObject({
    category: 'assistant',
    actor: {
      user: 'alice@example.com',
      groups: ['developers', 'on-call', 'system:authenticated'],
      via: 'assistant',
      assistant: 'Claude Code',
      session: expect.stringMatching(/^[0-9a-f]{16}$/),
      address: '127.0.0.1',
    },
    details: {
      tool: 'list_resources',
      cluster: 'demo',
      kind: 'pods',
      namespace: 'shop',
    },
  })
  expect(audited(served, 'assistant.ended')).toEqual([
    expect.objectContaining({
      outcome: 'success',
      summary: 'Claude Code was let go',
      actor: { user: 'alice@example.com', via: 'ui', assistant: 'Claude Code' },
      details: expect.objectContaining({ how: 'let go' }),
    }),
  ])
})

test('changes wait for the person’s answer, on their own pages only', async ({
  page,
  context,
  browser,
  serve,
}) => {
  await fakeNotifications(context, 'granted')
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1500' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  // Bob, signed in elsewhere, sees none of hers.
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo`, PEOPLE.bob.token)
  const { client } = await connect(page, served)
  await page.goto(`${served.url}cluster/demo`)
  await expect(page.getByRole('button', { name: 'AI assistants (1 connected)' })).toBeVisible()

  // While her tab is elsewhere, the browser tells her; the assistant hears where to send her.
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }),
  )
  const asked = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  const [, id] = asked.text.match(
    new RegExp(
      `^Still waiting for the person’s answer in Lumovi \\(${served.url.slice(0, -1)}\\): nothing has changed yet\\. .* id “([\\w-]+)”`,
    ),
  )!
  // Asked, and not answered yet: recorded so (what becomes of it is its own event).
  expect(audited(served, 'assistant.tool').at(-1)).toMatchObject({
    outcome: 'success',
    details: expect.objectContaining({ tool: 'scale', changing: true, waiting: true }),
  })
  const dialog = approval(page, 'Scale Deployment cart to 3 replicas')
  await expect(dialog).toContainText('Claude Code asks')
  await expect
    .poll(() => page.evaluate(() => (window as { __notices?: unknown[] }).__notices))
    .toEqual([
      {
        title: 'Claude Code asks to change demo',
        body: 'Scale Deployment cart to 3 replicas. Review it in Lumovi.',
      },
    ])
  await page.evaluate(() =>
    (window as { __lastNotice?: { onclick(): void } }).__lastNotice!.onclick(),
  )
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', {
      get: () => 'visible',
      configurable: true,
    }),
  )
  await expect(approval(bob, 'Scale Deployment cart to 3 replicas')).toBeHidden()

  // Answered on her page: made, and the server's log says who and what.
  await dialog.getByRole('button', { name: /^Approve/ }).click()
  expect(await call(client, 'wait_for_change', { id })).toEqual({
    error: false,
    text: expect.stringMatching(/^Scaled cart to 3 replicas, approved in Lumovi\./),
  })
  expect(served.log()).toContain(
    'alice@example.com’s Claude Code: Scale Deployment cart to 3 replicas in demo, made',
  )

  // In front, a change waiting tells nobody; rejected with a note, the assistant reads it.
  const restarting = call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason: 'Stale.',
  })
  const restart = approval(page, 'Restart Deployment cart')
  await restart.getByRole('button', { name: 'Reject…' }).click()
  await restart.getByRole('textbox', { name: 'Note' }).fill('Not now.')
  await page.keyboard.press('ControlOrMeta+Enter')
  expect(await outcome(client, restarting)).toBe(
    'The person rejected it in Lumovi, saying: “Not now.”. Nothing was changed.',
  )
  expect(served.log()).toContain('Restart Deployment cart in demo, rejected: Not now.')
  expect(await page.evaluate(() => (window as { __notices?: unknown[] }).__notices)).toHaveLength(1)

  // A change waiting while no page of hers is open shows on the next one.
  await page.goto('about:blank')
  const later = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 1,
    reason: 'Quiet.',
  })
  await page.goto(`${served.url}cluster/demo`)
  await approval(page, 'Scale Deployment cart to 1 replica')
    .getByRole('button', { name: /^Approve/ })
    .click()
  expect(await outcome(client, later)).toMatch(/^Scaled cart to 1 replica, approved in Lumovi\./)
  await elsewhere.close()

  // The audit log: each change as the assistant asked it, and as she answered, after how long.
  const changes = audited(served).filter((e) => e.category === 'change')
  expect(changes.map((e) => [e.action, e.outcome, e.summary, e.approval?.status])).toEqual([
    ['resource.scale', 'success', 'Scaled Deployment cart to 3 replicas', 'approved'],
    ['resource.restart', 'refused', 'Restart Deployment cart', 'rejected'],
    ['resource.scale', 'success', 'Scaled Deployment cart to 1 replica', 'approved'],
  ])
  expect(changes[0]).toMatchObject({
    actor: { user: 'alice@example.com', via: 'assistant', assistant: 'Claude Code' },
    target: { kind: 'Deployment', name: 'cart', namespace: 'shop', uid: expect.any(String) },
    command: 'kubectl scale deployment/cart --replicas=3 -n shop --context demo',
    approval: { by: 'alice@example.com', waitedMs: expect.any(Number) },
    details: { reason: 'Busy.' },
  })
  expect(changes[1]!.approval).toMatchObject({ by: 'alice@example.com', note: 'Not now.' })
  expect(changes[1]!.error).toBeUndefined()

  // On her Audit page: through her assistant, and how she answered.
  await page.goto(`${served.url}audit`)
  const events = page.getByRole('listbox', { name: 'Events' })
  const scaled = events.getByRole('option', { name: /Scaled Deployment cart to 3 replicas$/ })
  await expect(scaled).toContainText('alice@example.comClaude Code')
  await scaled.click()
  const event = page.getByRole('complementary', { name: 'Event' })
  await expect(event.getByRole('region', { name: 'Who' })).toContainText(
    'ThroughClaude Code, an AI assistant acting as them',
  )
  await expect(event.getByRole('region', { name: 'Approval' })).toHaveText(
    /^ApprovalAnswerApprovedByalice@example.comWaited\d+s$/,
  )
  await events.getByRole('option', { name: /Restart Deployment cart, refused$/ }).click()
  await expect(event.getByRole('region', { name: 'Approval' })).toHaveText(
    /^ApprovalAnswerRejectedByalice@example.comWaited\d+sTheir note“Not now\.”$/,
  )
  // And the object's own.
  await page.goto(`${served.url}cluster/demo/deployments?open=Deployment/shop/cart`)
  const cart = page.getByRole('complementary', { name: 'Deployment cart' })
  await cart.getByRole('tab', { name: 'Audit' }).click()
  await expect(cart.getByRole('list', { name: 'Audit log' })).toContainText(
    'alice@example.com through Claude Code',
  )
})

test('signing out of Lumovi lets the person’s assistants go', async ({ page, browser, serve }) => {
  const served = await serve({ env: { LUMOVI_APPROVAL_SLICE_MS: '1000' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  // A change still waiting for her answer…
  const asked = await call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  expect(asked.text).toMatch(/^Still waiting/)
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo`, PEOPLE.bob.token)
  const { client: bobs } = await connect(bob, served)
  await page.goto(`${served.url}cluster/demo`)
  // Put aside, it waits on her page as she signs out.
  await approval(page, 'Scale Deployment cart to 3 replicas')
    .getByRole('button', { name: 'Later' })
    .click()
  await page.getByRole('button', { name: 'Signed in as alice@example.com' }).click()
  await page
    .getByRole('dialog', { name: 'Account' })
    .getByRole('button', { name: 'Sign out' })
    .click()
  await expect(page.getByRole('heading', { name: 'Sign in to Lumovi' })).toBeVisible()
  await expect(call(client, 'list_clusters')).rejects.toThrow()
  expect(served.log()).toContain('alice@example.com’s Claude Code can no longer use Lumovi')
  // …is withdrawn with it.
  expect(served.log()).toContain('Scale Deployment cart to 3 replicas in demo, withdrawn')
  expect(audited(served, 'resource.scale')).toEqual([
    expect.objectContaining({
      outcome: 'cancelled',
      summary: 'Scale Deployment cart to 3 replicas',
      approval: { status: 'withdrawn', waitedMs: expect.any(Number) },
      error: 'The assistant was let go before it was answered.',
    }),
  ])
  expect(audited(served, 'assistant.ended')).toEqual([
    expect.objectContaining({
      summary: 'Claude Code can no longer use Lumovi',
      actor: { user: 'alice@example.com', via: 'assistant', assistant: 'Claude Code' },
      details: expect.objectContaining({ how: 'expired' }),
    }),
  ])
  // Bob's, allowed in his own session, carries on.
  expect((await call(bobs, 'list_clusters')).error).toBe(false)
  await elsewhere.close()
})

test('a person may deny an assistant, and a request that isn’t right is refused', async ({
  page,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const back = await callback()
  const assistant = new Assistant(back.url)
  const transport = new StreamableHTTPClientTransport(new URL('mcp', served.url), {
    authProvider: assistant,
  })
  await expect(new Client({ name: 'x', version: '1' }).connect(transport)).rejects.toThrow(
    UnauthorizedError,
  )
  const asking = assistant.authorizationUrl!
  await page.goto(asking.href)
  await expect(page).toHaveTitle('Allow an AI assistant — Lumovi')
  const request = page.getByRole('region', { name: 'Allow an assistant' })
  await expect(request).toContainText(
    `Claude Code (lumovi)wants to use Lumovi as alice@example.com`,
  )
  await expect(request).toContainText(`Then it goes back to ${new URL(back.url).host}.`)
  await request.getByRole('button', { name: 'Deny' }).click()
  const denied = await back.answer
  expect(audited(served, 'assistant.denied')).toEqual([
    expect.objectContaining({
      outcome: 'success',
      summary: 'Didn’t allow Claude Code (lumovi) to use Lumovi',
      actor: expect.objectContaining({ user: 'alice@example.com', via: 'ui' }),
      details: expect.objectContaining({ returnsTo: new URL(back.url).origin }),
    }),
  ])
  await page.waitForURL((url) => url.href.startsWith(back.url))
  expect(Object.fromEntries(denied)).toEqual({
    error: 'access_denied',
    ...(asking.searchParams.has('state') ? { state: asking.searchParams.get('state') } : {}),
    iss: served.url.slice(0, -1),
  })
  back.close()

  // What's wrong with a request, said where the person is.
  const wrong = async (change: (query: URLSearchParams) => void, why: string) => {
    const query = new URLSearchParams(asking.search)
    change(query)
    await page.goto(`${served.url}authorize?${query}`)
    await expect(page.getByRole('alert')).toHaveText(
      `This request to allow an assistant can’t be answered: ${why} Start again from the assistant.`,
    )
  }
  await wrong((q) => q.set('client_id', 'someone'), 'It doesn’t say which assistant it is.')
  await wrong(
    (q) => q.set('client_id', 'lumovi-bm90LWpzb24'),
    'It doesn’t say which assistant it is.',
  )
  await wrong(
    (q) =>
      q.set(
        'client_id',
        `lumovi-${Buffer.from('["x",["javascript:alert(1)"]]').toString('base64url')}`,
      ),
    'It doesn’t say which assistant it is.',
  )
  await wrong((q) => q.delete('redirect_uri'), 'It goes back somewhere the assistant didn’t name.')
  await wrong(
    (q) => q.set('redirect_uri', 'https://evil.example/'),
    'It goes back somewhere the assistant didn’t name.',
  )
  await wrong((q) => q.set('response_type', 'token'), 'It asks for something other than a code.')
  await wrong((q) => q.delete('code_challenge'), 'It has no PKCE code challenge (S256).')
  await wrong(
    (q) => q.set('resource', 'https://elsewhere.example/mcp'),
    `It’s for https://elsewhere.example/mcp, not Lumovi’s ${served.url}mcp.`,
  )

  // The answer must come from Lumovi's own page, signed in.
  const fromElsewhere = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: 'https://evil.example' },
    data: { query: asking.search.slice(1), approved: true },
  })
  expect(fromElsewhere.status()).toBe(403)
  const malformed = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: new URL(served.url).origin },
    data: { approved: 'yes' },
  })
  expect(await malformed.json()).toEqual({
    error: 'Expected the request, and whether it’s allowed.',
  })
  const anonymous = await fetch(`${served.url}api/assistants/authorize${asking.search}`)
  expect(anonymous.status).toBe(401)

  // Answered, but the server can't go on with it: said on the page.
  await page.route('**/api/assistants/authorize', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 400, json: { error: 'It has expired.' } })
      : route.fallback(),
  )
  await page.goto(asking.href)
  await page.getByRole('button', { name: 'Allow' }).click()
  await expect(page.getByRole('alert')).toContainText('It has expired.')
})

/** POSTs a form, as OAuth's token and revocation requests are. */
const form = (
  url: string,
  fields: Record<string, string>,
  type = 'application/x-www-form-urlencoded',
) =>
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: new URLSearchParams(fields).toString(),
  })

test('codes are swapped for tokens once, with their PKCE verifier, and renewed', async ({
  page,
  serve,
}) => {
  const served = await serve({
    env: {
      LUMOVI_ASSISTANT_TOKEN_SECONDS: '1',
      LUMOVI_ASSISTANT_REUSE_MS: '1000',
      LUMOVI_ASSISTANT_REDIRECT_HOSTS: 'assistant.example',
      // Swept often: what has run out goes.
      LUMOVI_ASSISTANTS_IDLE_MS: '500',
    },
  })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const token = `${served.url}oauth/token`

  // Registering: where an assistant may be sent back to.
  const register = (body: unknown) =>
    fetch(`${served.url}oauth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  for (const redirects of [
    [],
    'https://a.example/',
    ['http://evil.example/callback'],
    // A site, unless the administrator allows it: anyone could send someone's code there.
    ['https://evil.example/callback'],
    ['javascript:alert(1)'],
    ['https://assistant.example/#fragment'],
    ['not a url'],
  ]) {
    expect((await register({ redirect_uris: redirects })).status, String(redirects)).toBe(400)
  }
  expect(
    (await register({ client_name: 'Web', redirect_uris: ['https://assistant.example/callback'] }))
      .status,
  ).toBe(201)
  // Of what it names, only where it may go: VS Code's, say, with a site of its own.
  expect(
    await (
      await register({
        client_name: 'Visual Studio Code',
        redirect_uris: [
          'https://vscode.dev/redirect',
          'http://127.0.0.1:33418/',
          'https://evil.example/',
        ],
      })
    ).json(),
  ).toMatchObject({ redirect_uris: ['https://vscode.dev/redirect', 'http://127.0.0.1:33418/'] })
  const app = await (
    await register({ redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'] })
  ).json()
  expect(app).toMatchObject({ client_name: 'An AI assistant', token_endpoint_auth_method: 'none' })

  // An app's own scheme: the page says which app it goes back to.
  const verifier = 'v'.repeat(43)
  const challenge = Buffer.from(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  ).toString('base64url')
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: app.client_id,
    redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: `${served.url}mcp/`,
    state: 'from-cursor',
  })
  await page.goto(`${served.url}authorize?${query}`)
  const request = page.getByRole('region', { name: 'Allow an assistant' })
  await expect(request).toContainText('Then it goes back to cursor.')
  const allowed = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: new URL(served.url).origin },
    data: { query: query.toString(), approved: true },
  })
  const sentBack = new URL((await allowed.json()).redirect)
  expect(sentBack.searchParams.get('state')).toBe('from-cursor')
  const code = sentBack.searchParams.get('code')!

  const swap = (fields: Record<string, string>) =>
    form(token, {
      grant_type: 'authorization_code',
      code,
      client_id: app.client_id,
      redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
      code_verifier: verifier,
      ...fields,
    })
  const refusal = async (response: Response) => [response.status, (await response.json()).error]
  // Without what it needs: no code, or no refresh token.
  expect(await refusal(await form(token, { grant_type: 'authorization_code' }))).toEqual([
    400,
    'invalid_grant',
  ])
  expect(await refusal(await form(token, { grant_type: 'refresh_token' }))).toEqual([
    400,
    'invalid_grant',
  ])
  expect(await refusal(await form(token, { grant_type: 'password' }))).toEqual([
    400,
    'unsupported_grant_type',
  ])
  expect(await refusal(await form(token, {}, 'application/json'))).toEqual([400, 'invalid_request'])
  expect(
    await refusal(
      await form(token, { grant_type: 'refresh_token', refresh_token: 'x'.repeat(20_000) }),
    ),
  ).toEqual([400, 'invalid_request'])
  // Without its verifier, the code is spent: it's never good twice.
  expect(
    await refusal(
      await form(token, {
        grant_type: 'authorization_code',
        code,
        client_id: app.client_id,
        redirect_uri: 'cursor://anysphere.cursor-mcp/oauth/callback',
      }),
    ),
  ).toEqual([400, 'invalid_grant'])
  expect(await refusal(await swap({ code_verifier: 'w'.repeat(43) }))).toEqual([
    400,
    'invalid_grant',
  ])
  expect(await refusal(await swap({}))).toEqual([400, 'invalid_grant'])

  // A fresh code: swapped once, for another assistant's it's refused.
  const again = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: new URL(served.url).origin },
    data: { query: query.toString(), approved: true },
  })
  const fresh = new URL((await again.json()).redirect).searchParams.get('code')!
  expect(await refusal(await swap({ code: fresh, client_id: 'someone-else' }))).toEqual([
    400,
    'invalid_grant',
  ])
  const third = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: new URL(served.url).origin },
    data: { query: query.toString(), approved: true },
  })
  const good = new URL((await third.json()).redirect).searchParams.get('code')!
  const tokens = await (await swap({ code: good })).json()
  expect(tokens).toMatchObject({ token_type: 'Bearer', expires_in: 1 })
  // Listed for her, not yet used.
  await page.goto(`${served.url}cluster/demo`)
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  await page.getByRole('link', { name: /^Your assistants/ }).click()
  await expect(
    page.getByRole('region', { name: 'Your assistants' }).getByRole('listitem'),
  ).toHaveText([/^An AI assistantAllowed \d+s agoDisconnect$/])

  // Expired, an access token is refused; the refresh token renews it, once.
  await new Promise((resolve) => setTimeout(resolve, 1200))
  const mcp = (access: string) =>
    fetch(`${served.url}mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
  const expired = await mcp(tokens.access_token)
  expect(expired.status).toBe(401)
  expect(expired.headers.get('www-authenticate')).toBe(
    `Bearer error="invalid_token", resource_metadata="${served.url}.well-known/oauth-protected-resource/mcp"`,
  )
  const renewed = await (
    await form(token, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token })
  ).json()
  expect(renewed.refresh_token).not.toBe(tokens.refresh_token)
  expect(
    await refusal(
      await form(token, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }),
    ),
  ).toEqual([400, 'invalid_grant'])
  expect((await mcp(renewed.access_token)).status).toBe(400)

  // Revoked (signing an assistant out), it's gone; anything else is answered alike.
  const revoke = `${served.url}oauth/revoke`
  expect((await form(revoke, { token: 'unknown' })).status).toBe(200)
  expect((await form(revoke, {})).status).toBe(200)
  expect((await form(revoke, {}, 'application/json')).status).toBe(200)
  expect((await form(revoke, { token: renewed.refresh_token })).status).toBe(200)
  expect(
    await refusal(
      await form(token, { grant_type: 'refresh_token', refresh_token: renewed.refresh_token }),
    ),
  ).toEqual([400, 'invalid_grant'])
  expect(served.log()).toContain('alice@example.com’s An AI assistant signed out')

  // A refresh token used again, after a moment (no retry): someone else has a copy, and its
  // assistant is let go. Tokens nobody used, run out, go too.
  const allowed4 = await page.request.post(`${served.url}api/assistants/authorize`, {
    headers: { Origin: new URL(served.url).origin },
    data: { query: query.toString(), approved: true },
  })
  const copied = await (
    await swap({ code: new URL((await allowed4.json()).redirect).searchParams.get('code')! })
  ).json()
  const renewal = await (
    await form(token, { grant_type: 'refresh_token', refresh_token: copied.refresh_token })
  ).json()
  await new Promise((resolve) => setTimeout(resolve, 1_600))
  expect(
    await refusal(
      await form(token, { grant_type: 'refresh_token', refresh_token: copied.refresh_token }),
    ),
  ).toEqual([400, 'invalid_grant'])
  expect(
    await refusal(
      await form(token, { grant_type: 'refresh_token', refresh_token: renewal.refresh_token }),
    ),
  ).toEqual([400, 'invalid_grant'])
  expect(served.log()).toContain(
    'alice@example.com’s An AI assistant was let go: its refresh token was used again',
  )
  // Refused, in the audit log: someone else may have it.
  expect(audited(served, 'assistant.ended').map((e) => [e.details!.how, e.outcome])).toContainEqual(
    ['reused', 'refused'],
  )
})

test('assistants find how to sign in, at the origin’s root and below the base path', async ({
  serve,
}) => {
  const served = await serve({
    env: { LUMOVI_BASE_PATH: '/lumovi', LUMOVI_URL: 'https://lumovi.example.com' },
  })
  const origin = new URL(served.url).origin
  const json = async (path: string) => (await fetch(`${origin}${path}`)).json()
  const issuer = 'https://lumovi.example.com/lumovi'
  const server = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  }
  const resource = {
    resource: `${issuer}/mcp`,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_name: 'Lumovi',
  }
  expect(await json('/.well-known/oauth-authorization-server/lumovi')).toEqual(server)
  expect(await json('/lumovi/.well-known/oauth-authorization-server')).toEqual(server)
  expect(await json('/.well-known/oauth-protected-resource/lumovi/mcp')).toEqual(resource)
  expect(await json('/lumovi/.well-known/oauth-protected-resource')).toEqual(resource)
  expect(await json('/lumovi/.well-known/oauth-protected-resource/mcp')).toEqual(resource)
  // Nothing else at the root is Lumovi's.
  expect((await fetch(`${origin}/.well-known/openid-configuration`)).status).toBe(404)
  expect(
    (await fetch(`${origin}/.well-known/oauth-authorization-server/lumovi`, { method: 'POST' }))
      .status,
  ).toBe(404)

  // Without LUMOVI_URL, where the person (or assistant) reached it: over HTTPS at a proxy, say.
  const plain = await serve()
  const behind = await fetch(`${plain.url}.well-known/oauth-authorization-server`, {
    headers: { 'X-Forwarded-Proto': 'https' },
  })
  expect((await behind.json()).issuer).toBe(`https://${new URL(plain.url).host}`)
})

test('behind a proxy, an assistant acts as who allowed it, for as long as a session lasts', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy', LUMOVI_SESSION_HOURS: '0.001' } })
  await context.setExtraHTTPHeaders({ 'X-Forwarded-User': 'frank@example.com' })
  await page.goto(`${served.url}cluster/demo`)
  const { client } = await connect(page, served)
  // Its requests carry no proxy's headers: it's Frank, impersonated, all the same.
  expect((await call(client, 'list_resources', { cluster: 'demo', kind: 'ns' })).error).toBe(false)
  expect(clusters.demo.requests.at(-1)?.user).toBe('frank@example.com')
  await new Promise((resolve) => setTimeout(resolve, 3_700))
  await expect(call(client, 'list_clusters')).rejects.toThrow()
  expect(served.log()).toContain('frank@example.com’s Claude Code can no longer use Lumovi')
})

test('behind a proxy, an assistant acts as who the proxy says its person is now', async ({
  page,
  context,
  serve,
  clusters,
}) => {
  const served = await serve({ env: { LUMOVI_AUTH: 'proxy' } })
  const as = (groups: string) =>
    context.setExtraHTTPHeaders({
      'X-Forwarded-User': 'frank@example.com',
      'X-Forwarded-Groups': groups,
    })
  await as('platform')
  await page.goto(`${served.url}cluster/demo`)
  const { client, assistant } = await connect(page, served)
  const groups = async (connected: Client) => {
    expect((await call(connected, 'list_resources', { cluster: 'demo', kind: 'ns' })).error).toBe(
      false,
    )
    return clusters.demo.requests.at(-1)?.headers['impersonate-group']
  }
  expect(await groups(client)).toBe('platform')
  // In another group now: his next page says so, and his assistant starts again as that.
  await as('sre')
  await page.goto(`${served.url}cluster/demo`)
  await expect(page.getByRole('button', { name: 'AI assistants (1 connected)' })).toBeVisible()
  await expect(call(client, 'list_clusters')).rejects.toThrow('That session has ended')
  const again = new Client({ name: 'claude-code', version: '1.0.0' })
  await again.connect(
    new StreamableHTTPClientTransport(new URL('mcp', served.url), { authProvider: assistant }),
  )
  expect(await groups(again)).toBe('sre')
})

test('a cluster made read-only for everyone is read-only for everyone’s assistants', async ({
  page,
  browser,
  serve,
}) => {
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  // Bob, in a browser of his own, makes demo read-only.
  const elsewhere = await browser.newContext()
  const bob = await elsewhere.newPage()
  await signIn(bob, `${served.url}cluster/demo`, PEOPLE.bob.token)
  await bob.getByRole('button', { name: 'Cluster', exact: true }).click()
  await bob.getByRole('switch', { name: 'Read-only' }).click()
  await bob.keyboard.press('Escape')
  // Alice's assistant is told, and refused.
  await expect
    .poll(async () => (await call(client, 'list_clusters')).text)
    .toMatch(/changes: read-only/)
  const scale = {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  }
  expect((await call(client, 'scale', scale)).text).toMatch(
    /demo is read-only for everyone on this server: bob@example\.com made it so\./,
  )
  await page.goto(`${served.url}cluster/demo`)
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  await page.getByRole('link', { name: 'Permissions' }).click()
  await expect(page.getByLabel('What assistants are told')).toContainText('changes: read-only')
  await page.getByRole('button', { name: 'Back' }).click()

  // Alice allows changes again, and her assistant may ask for them.
  await page.getByRole('button', { name: 'Cluster', exact: true }).click()
  await page.getByRole('switch', { name: 'Read-only' }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await call(client, 'list_clusters')).text).toMatch(/changes: ask/)
  await elsewhere.close()
})

test('an administrator can turn assistants off', async ({ page, serve }) => {
  const served = await serve({ env: { LUMOVI_ASSISTANTS: 'off' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  await page.keyboard.press('ControlOrMeta+k')
  await page.getByRole('option', { name: 'AI assistants…' }).click()
  await expect(page.getByRole('main')).toContainText(
    'This server’s administrator has turned AI assistants off.',
  )
  await expect(page.getByRole('link', { name: 'Permissions' })).toHaveCount(0)
  expect(
    await page.evaluate(() =>
      window.lumovi!.aiPermissions!.get().catch((error: Error) => error.message),
    ),
  ).toContain('This server’s administrator has turned AI assistants off.')
  await page.getByRole('button', { name: 'Back' }).click()
  await expect(page.getByRole('button', { name: /^AI assistants/ })).toHaveCount(0)
  // Nothing of theirs is there; a request to allow one says so.
  for (const path of ['mcp', 'oauth/token', 'oauth/register']) {
    expect((await fetch(`${served.url}${path}`, { method: 'POST' })).status, path).toBe(404)
  }
  for (const path of ['mcp', '.well-known/oauth-protected-resource/mcp']) {
    expect((await fetch(`${served.url}${path}`)).status, path).toBe(404)
  }
  await page.goto(`${served.url}authorize?client_id=lumovi-x`)
  await expect(page.getByRole('alert')).toContainText(
    'This server’s administrator has turned AI assistants off.',
  )
})

test('an administrator says what assistants’ changes do, cluster by cluster', async ({
  page,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_ASSISTANT_CHANGES: 'never, demo = allow' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const { client } = await connect(page, served)
  await page.goto(`${served.url}cluster/demo`)
  // Never, but in demo: a limit everywhere else, which people's own rules don't loosen.
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  await page.getByRole('link', { name: 'Permissions' }).click()
  await expect(
    page.getByRole('article', { name: 'Changes (LUMOVI_ASSISTANT_CHANGES)' }),
  ).toHaveText(
    /^Changes \(LUMOVI_ASSISTANT_CHANGES\)Set by your administrator!demo\s+\/\s+all namespacesNo changes0 namespaces$/,
  )
  // Demo's, she lets assistants change without asking.
  await page
    .getByRole('region', { name: 'Defaults' })
    .getByRole('group', { name: 'Changes' })
    .getByRole('button', { name: 'Without asking' })
    .click()
  await expect
    .poll(() =>
      page.evaluate(() => window.lumovi!.aiPermissions!.get().then((v) => v.mine.defaults.changes)),
    )
    .toBe('allow')
  await page.getByRole('button', { name: 'Back' }).click()
  const restarted = await call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason: 'Stale.',
  })
  expect(restarted.text).toMatch(/^Restarted cart\. /)
  await expect(page.getByRole('status').filter({ hasText: 'Restarted cart' })).toContainText(
    'Claude Code changed demo without asking',
  )
  expect(served.log()).toContain('Restart Deployment cart in demo, made without asking')
})

test('assistants’ settings that don’t make sense stop the server', async ({ clusters }) => {
  expect(await refusedConfig(clusters, { LUMOVI_ASSISTANTS: 'maybe' })).toContain(
    'LUMOVI_ASSISTANTS must be on or off, not "maybe".',
  )
  for (const setting of ['sometimes', 'ask,=never', 'ask,demo=maybe']) {
    expect(await refusedConfig(clusters, { LUMOVI_ASSISTANT_CHANGES: setting }), setting).toContain(
      `LUMOVI_ASSISTANT_CHANGES must be ask, allow or never, with clusters' own after it (ask,staging=allow), not "${setting}".`,
    )
  }
  expect(
    await refusedConfig(clusters, { LUMOVI_ASSISTANT_REDIRECT_HOSTS: 'https://a.example/' }),
  ).toContain(
    'LUMOVI_ASSISTANT_REDIRECT_HOSTS must be host names, like assistant.example.com, not "https://a.example/".',
  )
})

test('each assistant keeps to its own sessions, and quiet ones are let go', async ({
  page,
  serve,
}) => {
  const served = await serve({ env: { LUMOVI_ASSISTANTS_IDLE_MS: '1500' } })
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  const code = await connect(page, served)
  const cursor = await connect(page, served, { name: 'cursor-vscode', clientName: 'Cursor' })
  // Connecting again, it keeps its name.
  const again = new Client({ name: 'cursor-vscode', version: '1.0.0' })
  await again.connect(
    new StreamableHTTPClientTransport(new URL('mcp', served.url), {
      authProvider: cursor.assistant,
    }),
  )
  // In use all along, however long what follows takes.
  let calls = 0
  const using = setInterval(
    () =>
      void call(again, 'list_clusters').then(
        () => calls++,
        () => {},
      ),
    250,
  )
  const mcp = (headers: Record<string, string>, body?: string, method = 'POST') =>
    fetch(`${served.url}mcp`, {
      method,
      headers: {
        Authorization: `Bearer ${cursor.assistant.tokens()!.access_token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...headers,
      },
      body,
    })
  const refusal = async (response: Response) => [
    response.status,
    (await response.json()).error.message,
  ]
  const list = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  // Claude Code's session is as good as gone to Cursor.
  const theirs = (code.client.transport as StreamableHTTPClientTransport).sessionId!
  expect(await refusal(await mcp({ 'Mcp-Session-Id': theirs }, list))).toEqual([
    404,
    'That session has ended: start a new one.',
  ])
  expect(await refusal(await mcp({}, list))).toEqual([400, 'Start a session first (initialize).'])
  expect(await refusal(await mcp({}, undefined, 'GET'))).toEqual([
    400,
    'Start a session first (initialize).',
  ])
  expect(await refusal(await mcp({}, '{ nope'))).toEqual([
    400,
    'That isn’t a JSON-RPC message (or it’s more than 4 MB).',
  ])

  // Its own page's calls about them are checked.
  await page.goto(`${served.url}cluster/demo`)
  expect(
    await page.evaluate(() =>
      window.lumovi!.serverAssistants!.revoke(5 as never).catch((error: Error) => error.message),
    ),
  ).toContain('Expected an assistant’s id')
  expect(
    await page.evaluate(() => window.lumovi!.serverAssistants!.revoke('someone-elses')),
  ).toMatchObject({ clients: [{ name: 'Claude Code' }, { name: 'Cursor' }] })
  expect(
    await page.evaluate(() =>
      window
        .lumovi!.approvals!.decide(5 as never, { approved: true })
        .catch((error: Error) => error.message),
    ),
  ).toContain('Expected a change’s id')

  // Quiet for a while (idle, then the sweep after), a session is let go; Cursor's other one,
  // in use, isn't.
  const since = calls
  await new Promise((resolve) => setTimeout(resolve, 3_500))
  clearInterval(using)
  expect(calls).toBeGreaterThan(since)
  expect((await call(again, 'list_clusters')).error).toBe(false)
  await expect(call(code.client, 'list_clusters')).rejects.toThrow()
})

test('a person may let the browser tell them of changes waiting', async ({
  page,
  context,
  serve,
}) => {
  await fakeNotifications(context)
  const served = await serve()
  await signIn(page, `${served.url}cluster/demo`, PEOPLE.alice.token)
  await page.getByRole('button', { name: 'AI assistants', exact: true }).click()
  const dialog = page.getByRole('main')
  await page.getByRole('link', { name: /^Your assistants/ }).click()
  await expect(dialog.getByRole('region', { name: 'Your assistants' })).toContainText('None yet')
  await page.getByRole('link', { name: 'Connect' }).click()
  const notifications = dialog.getByRole('region', { name: 'Notifications', exact: true })
  await expect(notifications).toContainText('Let this browser tell you when a change waits')
  await notifications.getByRole('button', { name: 'Notify me' }).click()
  await expect(notifications).toContainText('This browser tells you when a change waits for you.')
  await page.getByRole('button', { name: 'Back' }).click()
  await page.evaluate(() => Object.assign(Notification, { permission: 'denied' }))
  await page.getByRole('button', { name: 'AI assistants', exact: true }).click()
  await expect(notifications).toContainText('This browser’s settings block Lumovi’s notifications.')
  await page.getByRole('button', { name: 'Back' }).click()

  // Blocked, a change waiting while the tab is elsewhere shows only on it.
  const { client } = await connect(page, served)
  await page.goto(`${served.url}cluster/demo`)
  await page.evaluate(() => {
    Object.assign(Notification, { permission: 'denied' })
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true })
  })
  const scaling = call(client, 'scale', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    replicas: 3,
    reason: 'Busy.',
  })
  await approval(page, 'Scale Deployment cart to 3 replicas')
    .getByRole('button', { name: /^Approve/ })
    .click()
  expect((await scaling).error).toBe(false)
  expect(await page.evaluate(() => (window as { __notices?: unknown[] }).__notices)).toEqual([])

  // A browser without notifications at all (Safari on a phone, say): none offered, none sent.
  await page.addInitScript(() => delete (window as { Notification?: unknown }).Notification)
  await page.goto(`${served.url}cluster/demo`)
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true }),
  )
  await page.getByRole('button', { name: 'AI assistants (1 connected)' }).click()
  await expect(page.getByRole('region', { name: 'Connect an assistant' })).toBeVisible()
  await expect(
    page.getByRole('main').getByRole('region', { name: 'Notifications', exact: true }),
  ).toHaveCount(0)
  await page.getByRole('button', { name: 'Back' }).click()
  const restarting = call(client, 'restart', {
    cluster: 'demo',
    kind: 'deploy',
    namespace: 'shop',
    name: DEMO.deployments.cart,
    reason: 'Stale.',
  })
  await approval(page, 'Restart Deployment cart')
    .getByRole('button', { name: /^Approve/ })
    .click()
  expect(await outcome(client, restarting)).toMatch(/^Restarted cart/)
})
