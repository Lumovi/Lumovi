import { CircleAlert, Keyboard, Lock, Pencil, RotateCcw, TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  chordCaps,
  chordOf,
  chordText,
  clashOf,
  defaultKeys,
  normalChord,
  PLACE_NAMES,
  SHORTCUTS,
  shortcutOf,
  type Clash,
  type KeyPress,
} from '@shared/shortcuts'
import { Button } from '@renderer/components/Button'
import { Kbd } from '@renderer/components/Kbd'
import { SearchInput } from '@renderer/components/SearchInput'
import { usePreferences, useSetPreferences, useSettings } from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { DESKTOP, MAC, useKeys } from '@renderer/lib/shortcuts'
import { useSheet, type SheetRow } from '../shell/sheet'

/** A chord as a sentence says it: "⌘ [" on a Mac, "Ctrl+[" off one. */
const said = (chord: string) => (MAC ? chordCaps(chord, true).join(' ') : chordText(chord, false))

/** What's asked before keys are taken or given back, and what to do on yes. */
type Asking = { line: string; key: string; yes: string; then: () => void }

/** A message with the key it's about set apart, as its subject. */
function Keyed({ text, keyText }: { text: string; keyText: string }) {
  const at = text.indexOf(keyText)
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <b className="font-medium">{keyText}</b>
      {text.slice(at + keyText.length)}
    </>
  )
}

/**
 * Settings' Keyboard shortcuts (LMV-358): every key Lumovi has, grouped as the ? sheet groups
 * them. A command's can be changed (pressed while it records), put back, or all put back; one
 * the organization sets is locked; one built in is said so. A key that can't be taken is refused
 * with why; one another command has where both work is asked about first.
 */
export function ShortcutsSection() {
  const sheet = useSheet()
  const { all: keys } = useKeys()
  const own = usePreferences().shortcuts
  const locked = (useSettings().data?.locked ?? [])
    .filter((name) => name.startsWith('shortcuts.'))
    .map((name) => name.slice('shortcuts.'.length))
  const set = useSetPreferences()
  const [search, setSearch] = useState('')
  const [recording, setRecording] = useState<string>()
  const [refused, setRefused] = useState<{ text: string; key: string }>()
  const [asking, setAsking] = useState<Asking & { id: string }>()
  const [resetting, setResetting] = useState(false)

  /** Keys as they'd be: the person's where they aren't a command's defaults (none locked). */
  const save = (next: Record<string, string[]>) => {
    const changed: Record<string, string[]> = {}
    for (const { id } of SHORTCUTS) {
      if (locked.includes(id)) continue
      if (JSON.stringify(next[id]) !== JSON.stringify(defaultKeys(id, MAC))) changed[id] = next[id]!
    }
    return set({ shortcuts: changed })
  }
  const stop = () => {
    setRecording(undefined)
    setRefused(undefined)
    setAsking(undefined)
  }
  /** Without a chord, and so without the keys another command loses to this one. */
  const without = (id: string, chord: string) =>
    keys[id]!.filter((key) => normalChord(key, MAC) !== normalChord(chord, MAC))

  /** A key pressed while a command records. */
  const press = (id: string, event: KeyPress) => {
    if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) {
      stop()
      return
    }
    // Keys as pressed: off a Mac the ⊞ key stands in for Ctrl only when a command runs, and its
    // own keys are the system's (Windows' and the Linux desktop's).
    if (!MAC && event.metaKey) {
      if (['Meta', 'OS'].includes(event.key)) return
      setAsking(undefined)
      setRefused({ text: '⊞ keys stay the system’s. Press other keys, or Esc.', key: '⊞ keys' })
      return
    }
    const chord = chordOf(event, MAC)
    if (!chord) return
    if (asking && event.key === 'Enter') {
      asking.then()
      return
    }
    const clash = clashOf(id, chord, { keys, mac: MAC, desktop: DESKTOP, locked })
    setRefused(undefined)
    setAsking(undefined)
    if (clash?.kind === 'refused') {
      setRefused({
        text: `${said(chord)} ${clash.why} Press other keys, or Esc.`,
        key: said(chord),
      })
      return
    }
    const take =
      (extra: Record<string, string[]> = {}) =>
      () => {
        stop()
        void save({ ...keys, ...extra, [id]: [chord] })
      }
    if (!clash) return take()()
    setAsking({ id, ...ask(clash, chord, take) })
  }
  const ask = (
    clash: Exclude<Clash, { kind: 'refused' }>,
    chord: string,
    take: (extra?: Record<string, string[]>) => () => void,
  ): Asking => {
    const other = shortcutOf(clash.by)
    if (clash.kind === 'taken') {
      const left = without(other.id, chord)
      return {
        key: said(chord),
        line: `${said(chord)} is ${other.label}’s. Use it here, and ${other.label} ${left.length ? `keeps ${left.map(said).join(' and ')}` : 'has no keys until you give it some'}.`,
        yes: 'Use it here',
        then: take({ [other.id]: left }),
      }
    }
    return {
      key: said(chord),
      line:
        clash.kind === 'narrower'
          ? `${PLACE_NAMES[other.place]}, ${said(chord)} is still ${other.label}. Use it anyway?`
          : `Everywhere else, ${said(chord)} is ${other.label}. Use it anyway?`,
      yes: 'Use it anyway',
      then: take(),
    }
  }

  // While recording, every key is its: on the desktop main sends them (the menu's too).
  const pressRef = useRef(press)
  useEffect(() => {
    pressRef.current = press
  })
  useEffect(() => {
    if (!recording) return
    if (api.desktop) {
      api.desktop.recordKeys(true)
      const off = api.desktop.onKeyRecorded((event) => pressRef.current(recording, event))
      return () => {
        off()
        api.desktop!.recordKeys(false)
      }
    }
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault()
      event.stopImmediatePropagation()
      pressRef.current(recording, event)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])
  // Recording ends as the row loses the keyboard, not only on Esc: a click elsewhere, the window
  // losing focus (another window or app), the page hidden. Its keys are the menus' again.
  const stopRef = useRef(stop)
  useEffect(() => {
    stopRef.current = stop
  })
  useEffect(() => {
    if (!recording) return
    const end = () => stopRef.current()
    const outside = (event: PointerEvent) => {
      if (!(event.target instanceof Element && event.target.closest('[data-recording]'))) end()
    }
    const hidden = () => document.visibilityState === 'hidden' && end()
    window.addEventListener('blur', end)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', end)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('visibilitychange', hidden)
    }
  }, [recording])

  /** Puts a command's defaults back: asked first where another command in its place has one. */
  const putBack = (id: string) => {
    const defaults = defaultKeys(id, MAC)
    const held = defaults
      .map((chord) => ({ chord, clash: clashOf(id, chord, { keys, mac: MAC, desktop: DESKTOP }) }))
      .find(({ clash }) => clash?.kind === 'taken')
    if (!held) return void save({ ...keys, [id]: defaults })
    const other = shortcutOf((held.clash as { by: string }).by)
    const left = without(other.id, held.chord)
    const label = shortcutOf(id).label
    setRecording(undefined)
    setAsking({
      id,
      key: said(held.chord),
      line: `${said(held.chord)} is ${other.label}’s now. Give it back to ${label}, and ${other.label} ${left.length ? `keeps ${left.map(said).join(' and ')}` : 'has no keys'}?`,
      yes: 'Give it back',
      then: () => {
        stop()
        void save({ ...keys, [other.id]: left, [id]: defaults })
      },
    })
  }

  const changed = (id: string) => Object.hasOwn(own, id) && !locked.includes(id)
  const found = (row: SheetRow) => {
    const words = search.trim().toLowerCase()
    if (!words) return true
    const text = [row.label, ...row.keys.map((caps) => caps.join('')), ...row.keys.flat()]
    return text.some((part) => part.toLowerCase().includes(words))
  }

  return (
    <>
      <div className="mb-1.5 flex items-center gap-2.5">
        <SearchInput
          value={search}
          onChange={setSearch}
          onArrowDown={() => {}}
          placeholder="Search commands or keys"
          name="Search commands or keys"
          hint={false}
          hotkey={false}
          className="w-[280px] max-w-full"
        />
        <span className="flex-1" />
        {/* (Always in its place: off where nothing's changed, so the header doesn't shift.) */}
        <Button
          onClick={() => setResetting(true)}
          disabled={!Object.keys(own).some((id) => !locked.includes(id))}
          className="h-[30px]"
        >
          <RotateCcw />
          Reset all…
        </Button>
      </div>
      {resetting && (
        <div
          role="alert"
          className="mb-2 flex flex-wrap items-center gap-2.5 rounded-lg bg-warn/10 px-3 py-2 text-[12.5px] text-ink-1"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-warn-text" />
          <span className="min-w-0 flex-[1_1_320px]">
            Put back every command’s keys as Lumovi has them
            {locked.length ? ', but those your organization sets' : ''}?
          </span>
          <Button
            variant="primary"
            className="h-[26px] px-2 text-xs"
            onClick={() => {
              setResetting(false)
              stop()
              void set({ shortcuts: null })
            }}
          >
            Reset all
          </Button>
          <Button
            variant="ghost"
            className="h-[26px] px-2 text-xs"
            onClick={() => setResetting(false)}
          >
            Cancel
          </Button>
        </div>
      )}
      {sheet.map((section) => {
        const rows = section.rows.filter(found)
        if (!rows.length) return null
        return (
          <div key={section.title}>
            <h3 className="mt-[18px] mb-1.5 text-2xs font-medium tracking-wider text-ink-3 uppercase">
              {section.title}
            </h3>
            <div className="overflow-hidden rounded-[10px] border border-line">
              {rows.map((row) => (
                <Row
                  key={row.label}
                  row={row}
                  locked={row.id !== undefined && locked.includes(row.id)}
                  changed={row.id !== undefined && changed(row.id)}
                  recording={row.id !== undefined && recording === row.id}
                  refused={recording === row.id ? refused : undefined}
                  asking={asking && asking.id === row.id ? asking : undefined}
                  onRecord={() => {
                    setResetting(false)
                    setRefused(undefined)
                    setAsking(undefined)
                    setRecording(row.id)
                  }}
                  onPutBack={() => putBack(row.id!)}
                  onCancel={stop}
                />
              ))}
            </div>
          </div>
        )
      })}
    </>
  )
}

function Row({
  row,
  locked,
  changed,
  recording,
  refused,
  asking,
  onRecord,
  onPutBack,
  onCancel,
}: {
  row: SheetRow
  locked: boolean
  changed: boolean
  recording: boolean
  refused?: { text: string; key: string }
  asking?: Asking
  onRecord: () => void
  onPutBack: () => void
  onCancel: () => void
}) {
  const built = row.id === undefined
  const keys = (
    <span className="flex items-center gap-1">
      {row.keys.length === 0 && <span className="text-xs text-ink-3">None</span>}
      {row.keys.map((caps, i) => (
        <span key={caps.join('')} className="flex items-center gap-1">
          {i > 0 &&
            (row.apart ? (
              <span className="w-0.5" />
            ) : (
              <span className="px-0.5 text-xs text-ink-3">or</span>
            ))}
          {caps.map((key) => (
            <Kbd key={key}>{key}</Kbd>
          ))}
        </span>
      ))}
    </span>
  )
  const name = (
    <span className="min-w-0 truncate text-ink-1">
      {row.label}
      {changed && (
        <small className="ml-2 text-[11.5px] font-medium text-accent-strong">Changed</small>
      )}
      {built && <small className="ml-2 text-[11.5px] text-ink-3">Built in</small>}
    </span>
  )
  const recordable = !built && !locked
  return (
    <div
      role="group"
      aria-label={row.label}
      data-recording={recording || asking ? '' : undefined}
      className={cn(
        'group grid min-h-10 grid-cols-[minmax(0,1fr)_auto_28px] items-center gap-x-3 py-1 pr-2 pl-3.5 text-[13px] [&+&]:border-t [&+&]:border-line',
        (recording || asking) && 'bg-accent-soft',
      )}
    >
      {recordable && !recording ? (
        <button
          type="button"
          aria-label={`Change ${row.label}’s keys`}
          onClick={onRecord}
          className="col-span-2 grid grid-cols-subgrid items-center rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {name}
          {keys}
        </button>
      ) : (
        <>
          {name}
          {recording ? (
            <span
              role="status"
              className="inline-flex h-[26px] items-center gap-1.5 rounded-[7px] border-[1.5px] border-dashed border-accent px-2.5 text-xs text-accent-strong"
            >
              <Keyboard className="size-3.5" />
              Press the new keys · Esc to cancel
            </span>
          ) : (
            keys
          )}
        </>
      )}
      <span className="grid size-7 place-items-center">
        {locked ? (
          <Lock aria-label="Set by your organization" className="size-3.5 text-ink-3" />
        ) : changed && !recording ? (
          <button
            type="button"
            aria-label={`Put ${row.label}’s keys back`}
            onClick={onPutBack}
            className="grid size-7 place-items-center rounded-[7px] text-ink-3 outline-none hover:bg-surface-3 hover:text-ink-1 focus-visible:ring-2 focus-visible:ring-accent"
          >
            <RotateCcw className="size-[15px]" />
          </button>
        ) : (
          recordable &&
          !recording && (
            <Pencil
              aria-hidden
              className="size-3.5 text-ink-1 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
            />
          )
        )}
      </span>
      {refused && (
        <div
          role="alert"
          className="col-span-full my-1 flex items-start gap-2.5 rounded-lg bg-critical/8 px-2.5 py-2 text-[12.5px] leading-[18px] text-critical-text"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <Keyed text={refused.text} keyText={refused.key} />
          </span>
        </div>
      )}
      {asking && (
        <div
          role="alert"
          className="col-span-full my-1 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 rounded-lg bg-warn/10 px-2.5 py-2 text-[12.5px] leading-[18px] text-ink-1"
        >
          <TriangleAlert className="size-3.5 shrink-0 text-warn-text" />
          <span className="min-w-0 flex-[1_1_320px]">
            <Keyed text={asking.line} keyText={asking.key} />
          </span>
          <Button variant="primary" className="h-[26px] px-2 text-xs" onClick={asking.then}>
            {asking.yes}
          </Button>
          <Button variant="ghost" className="h-[26px] px-2 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  )
}
