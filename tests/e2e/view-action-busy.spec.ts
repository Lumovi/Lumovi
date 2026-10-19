/**
 * A view's action at work on its object: busy where it was, in Lumovi's bar and in the menus,
 * with how long once that's known, and never pressed again until it's done. One that asks its
 * own question and names its own button. And one offered while a condition held: sent with the
 * object's version it was judged on, so if the object changed meanwhile, nothing changes, and
 * Lumovi says so.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import type { KubeObject } from '../../src/shared/api.ts'
import { CUSTOM } from '../mock-cluster/fixtures/custom.ts'
import { dialog, menuAction, toasts, writes } from './action-helpers.ts'
import { expect, openCluster, panel, row, test } from './fixtures.ts'

const POLISHER = String.raw`
apiVersion: lumovi.dev/v1beta1
kind: Plugin
metadata:
  name: polisher
spec:
  version: 1.0.0
  needs: { lumovi: 1.0.0 }
  groups: [example.com]
  views:
    - name: widgets
      kinds:
        - { group: example.com, kind: Widget }
      actions:
        - name: Polish
          runs: at-once
          primary: true
          when: { path: .spec.polishing, exists: false }
          busy:
            - when:
                all:
                  - { path: .spec.polishing, exists: true }
                  - { path: .status.polishStarted, exists: true }
              word: Polishing
              since: .status.polishStarted
            - when: { path: .spec.polishing, exists: true }
              word: Polishing
          patch: { spec: { polishing: true } }
          done: Started polishing {{ .metadata.name }}
        - name: Stop polishing
          when: { path: .spec.polishing, exists: true }
          same: [.status.polishStarted]
          confirm: It stops where it is.
          confirmTitle: Stop polishing {{ .metadata.name }} now?
          confirmButton: Stop it
          patch: { spec: { polishing: null } }
          done: Stopped polishing {{ .metadata.name }}
        - name: Remember its size
          when: { path: .spec.size, exists: true }
          confirm: It keeps its size, as it is now.
          patch: { spec: { remembered: '{{ .spec.size }}' } }
        - name: Mark polished
          confirm: It says it's polished.
          patch: { status: { polished: true } }
`

const PATH = `/apis/example.com/v1/namespaces/default/widgets/${CUSTOM.widget}`

async function opened(page: Page, userDataDir: string) {
  const plugins = join(userDataDir, 'plugins')
  mkdirSync(plugins, { recursive: true })
  writeFileSync(join(plugins, 'polisher.yaml'), POLISHER)
  await openCluster(page)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'API resources' })
    .click()
  await page
    .getByRole('rowgroup', { name: 'example.com', exact: true })
    .getByRole('button', { name: /^Widgets\b/ })
    .click()
  await row(page, 'Widgets', CUSTOM.widget).getByRole('gridcell').nth(1).click()
  return panel(page, 'Widget', CUSTOM.widget)
}

/** The widget as the cluster holds it now, changed by `change`: as its tool would change it. */
function changed(
  clusters: {
    demo: {
      object(kind: string, ns: string, name: string): KubeObject | undefined
      upsert(object: KubeObject): void
    }
  },
  change: (widget: KubeObject) => KubeObject,
) {
  const widget = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!
  clusters.demo.upsert(change(structuredClone(widget)))
}

test('an action at work is busy where it was, with how long once that’s known, and can’t be pressed', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const detail = await opened(page, userDataDir)
  await detail.getByRole('button', { name: 'Polish', exact: true }).click()
  await expect(toasts(page)).toContainText(`Started polishing ${CUSTOM.widget}`)
  // Offered while a condition held: sent with the version it was judged on.
  expect(writes(clusters.demo, 'PATCH', PATH).at(-1)!.body).toEqual({
    spec: { polishing: true },
    metadata: { resourceVersion: expect.stringMatching(/^\d+$/) },
  })

  // Busy at once, where it was: before the tool has started, with no time.
  const busy = detail.getByRole('button', { name: /^Polish, busy/ })
  await expect(busy).toHaveAccessibleName('Polish, busy: polishing')
  await expect(busy).toHaveAttribute('aria-disabled', 'true')
  await expect(busy).toHaveText('Polishing')
  const sent = writes(clusters.demo, 'PATCH', PATH).length
  // (Pressed anyway, past what a person can: it goes nowhere.)
  await busy.click({ force: true })
  await expect(dialog(page)).toHaveCount(0)
  expect(writes(clusters.demo, 'PATCH', PATH)).toHaveLength(sent)

  // Once the tool says when it started: how long, counted by Lumovi, in the button and its name.
  const started = new Date(Date.now() - 65_000).toISOString().replace(/\.\d{3}Z$/, 'Z')
  changed(clusters, (widget) => ({
    ...widget,
    status: { ...widget.status, polishStarted: started },
  }))
  // (In whole minutes: a name that changed every second would be said every second.)
  await expect(busy).toHaveAccessibleName('Polish, busy: polishing, 1 minute')
  await expect(busy).toHaveText(/^Polishing1m \d\ds$/)
  // (From off it, as a person's pointer comes to it: the press above left it there.)
  await page.mouse.move(0, 0)
  await busy.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    /^Polishing for 1m \d\ds\. Polish can be pressed again when it’s done\.$/,
  )

  // In the panel's menu too: there, busy, and it can't be chosen.
  await detail.getByRole('button', { name: 'More actions' }).click()
  const item = page.getByRole('menuitem', { name: /^Polish, busy: polishing, 1 minute/ })
  await expect(item).toHaveAttribute('aria-disabled', 'true')
  await expect(item).toContainText(/Polishing\s*1m \d\ds/)
  await page.keyboard.press('Escape')

  // And in a row's own menu on the list.
  await row(page, 'Widgets', CUSTOM.widget).click({ button: 'right' })
  await expect(
    page.getByRole('menuitem', { name: /^Polish, busy: polishing, 1 minute/ }),
  ).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('Escape')

  // Past a day: in days and hours, written and said, the minutes left out.
  const long = new Date(Date.now() - (377 * 60 + 53) * 60_000).toISOString()
  changed(clusters, (widget) => ({
    ...widget,
    status: { ...widget.status, polishStarted: long.replace(/\.\d{3}Z$/, 'Z') },
  }))
  await expect(busy).toHaveAccessibleName('Polish, busy: polishing, 15 days 17 hours')
  await expect(busy).toHaveText('Polishing15d 17h')
  await page.mouse.move(0, 0)
  await busy.hover()
  await expect(page.getByRole('tooltip')).toHaveText(
    'Polishing for 15d 17h. Polish can be pressed again when it’s done.',
  )
  await detail.getByRole('button', { name: 'More actions' }).click()
  const days = page.getByRole('menuitem', { name: 'Polish, busy: polishing, 15 days 17 hours' })
  await expect(days).toContainText(/Polishing\s*15d 17h/)
  await page.keyboard.press('Escape')

  // Done: offered again.
  changed(clusters, (widget) => {
    delete (widget.spec as Record<string, unknown>).polishing
    return widget
  })
  await expect(detail.getByRole('button', { name: 'Polish', exact: true })).toBeVisible()
})

test('an action asks its own question and names its own button; judged again as it’s sent: its tool’s changes meanwhile are fine, its condition gone is not', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  changed(clusters, (widget) => ({ ...widget, spec: { ...widget.spec, polishing: true } }))
  await opened(page, userDataDir)
  await menuAction(page, 'Widget', CUSTOM.widget, 'Stop polishing…')
  const asked = dialog(page)
  await expect(asked.getByRole('heading')).toHaveText(`Stop polishing ${CUSTOM.widget} now?`)
  // (Lumovi names the object under it, whatever the question says.)
  await expect(asked).toContainText(CUSTOM.widget)

  // Its tool rewrites its status while the question is open (as Argo CD does every few seconds):
  // the condition still holds, so it goes, with the version read as it was sent.
  changed(clusters, (widget) => ({ ...widget, status: { ...widget.status, polishedPart: 'gear' } }))
  const current = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!.metadata
    .resourceVersion
  await asked.getByRole('button', { name: 'Stop it', exact: true }).click()
  await expect(toasts(page)).toContainText(`Stopped polishing ${CUSTOM.widget}`)
  expect(writes(clusters.demo, 'PATCH', PATH).at(-1)!.body).toEqual({
    spec: { polishing: null },
    metadata: { resourceVersion: current },
  })

  // Its condition gone by the time it's sent: nothing is sent, and Lumovi says why.
  changed(clusters, (widget) => ({ ...widget, spec: { ...widget.spec, polishing: true } }))
  await menuAction(page, 'Widget', CUSTOM.widget, 'Stop polishing…')
  const sent = writes(clusters.demo, 'PATCH', PATH).length
  changed(clusters, (widget) => {
    delete (widget.spec as Record<string, unknown>).polishing
    return widget
  })
  await dialog(page).getByRole('button', { name: 'Stop it', exact: true }).click()
  const notSent = `${CUSTOM.widget} has changed since you looked at it, so Stop polishing wasn’t sent and nothing changed. Look at it again.`
  await expect(dialog(page).getByRole('alert')).toHaveText(notSent)
  expect(writes(clusters.demo, 'PATCH', PATH)).toHaveLength(sent)
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // Changed between that read and its send: the cluster refuses it, and Lumovi says so.
  changed(clusters, (widget) => ({ ...widget, spec: { ...widget.spec, polishing: true } }))
  await menuAction(page, 'Widget', CUSTOM.widget, 'Stop polishing…')
  const conflict = clusters.demo.fail(PATH, { status: 409, method: 'PATCH' })
  await dialog(page).getByRole('button', { name: 'Stop it', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    `${CUSTOM.widget} changed while you looked at it, so nothing was changed. Look at it again.`,
  )
  conflict()
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // What its file says has to stay the same isn't (another run started meanwhile): nothing is sent.
  changed(clusters, (widget) => ({ ...widget, spec: { ...widget.spec, polishing: true } }))
  await menuAction(page, 'Widget', CUSTOM.widget, 'Stop polishing…')
  changed(clusters, (widget) => ({
    ...widget,
    status: { ...widget.status, polishStarted: '2026-10-14T09:00:00Z' },
  }))
  const before = writes(clusters.demo, 'PATCH', PATH).length
  await dialog(page).getByRole('button', { name: 'Stop it', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(notSent)
  expect(writes(clusters.demo, 'PATCH', PATH)).toHaveLength(before)
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()

  // What it would send, filled from what's there now, isn't what the person read: nothing is sent.
  await menuAction(page, 'Widget', CUSTOM.widget, 'Remember its size…')
  await expect(dialog(page)).toContainText('"remembered":3}')
  changed(clusters, (widget) => ({ ...widget, spec: { ...widget.spec, size: 4 } }))
  const unsent = writes(clusters.demo, 'PATCH', PATH).length
  await dialog(page).getByRole('button', { name: 'Remember its size', exact: true }).click()
  await expect(dialog(page).getByRole('alert')).toHaveText(
    `${CUSTOM.widget} changed while you looked at it, so nothing was changed. Look at it again.`,
  )
  expect(writes(clusters.demo, 'PATCH', PATH)).toHaveLength(unsent)
  await dialog(page).getByRole('button', { name: 'Cancel' }).click()
})

test('a plugin’s entry says the status an action writes, and an action’s own question and button', async ({
  lumovi,
}) => {
  const { page, userDataDir } = lumovi
  await opened(page, userDataDir)
  await page
    .getByRole('navigation', { name: 'Resources' })
    .getByRole('link', { name: 'All plugins' })
    .click()
  await page.locator('[data-plugin-row]').filter({ hasText: 'polisher' }).click()
  await expect(page.locator('[data-plugin-writes-status]')).toHaveText(
    'Writes Widgets’ status, in one place: status.polished, by Mark polished…, which asks you first.',
  )
  const actions = page.getByRole('region', { name: 'Its actions, and what each sends' })
  await expect(actions).toContainText('Its question: “Stop polishing {{ .metadata.name }} now?”')
  await expect(actions).toContainText('Its button: Stop it')
  await expect(actions).toContainText('Sent only if .status.polishStarted is as you saw it')
})

test('pressed from the keyboard, an action that becomes busy keeps the keyboard: on its busy button, where it was, and on it again once it’s done', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  const detail = await opened(page, userDataDir)
  await detail.getByRole('button', { name: 'Polish', exact: true }).focus()
  await page.keyboard.press('Enter')
  // Drawn anew, busy, in its place: the keyboard is there, never dropped to the page.
  const busy = detail.getByRole('button', { name: /^Polish, busy/ })
  await expect(busy).toBeVisible()
  await expect(busy).toBeFocused()
  await expect(page.locator('body')).not.toBeFocused()
  // Done, and drawn back in its place: the keyboard stays with it.
  changed(clusters, (widget) => {
    delete (widget.spec as Record<string, unknown>).polishing
    return widget
  })
  await expect(detail.getByRole('button', { name: 'Polish', exact: true })).toBeFocused({
    timeout: 15_000,
  })
})

test('the keyboard stays an object’s own: taken to another by its address, it isn’t put on that one’s button of the same name', async ({
  lumovi,
  clusters,
}) => {
  const { page, userDataDir } = lumovi
  // A second widget, beside the first.
  const widget = clusters.demo.object('Widget.example.com', 'default', CUSTOM.widget)!
  const other = structuredClone(widget)
  other.metadata = { ...other.metadata, name: 'green-widget', uid: 'green-widget-uid' }
  clusters.demo.upsert(other)
  const detail = await opened(page, userDataDir)
  await detail.getByRole('button', { name: 'Polish', exact: true }).focus()
  // To the other by its address, as a keyboard's way there changes it: the first one's bar goes.
  await page.evaluate(
    ([from, to]) => {
      window.location.hash = window.location.hash.replace(from!, to!)
    },
    [CUSTOM.widget, 'green-widget'],
  )
  const theirs = panel(page, 'Widget', 'green-widget').getByRole('button', {
    name: 'Polish',
    exact: true,
  })
  await expect(theirs).toBeVisible()
  await expect(theirs).not.toBeFocused()
})
