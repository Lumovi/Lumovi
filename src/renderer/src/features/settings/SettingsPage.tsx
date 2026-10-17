import {
  ChevronRight,
  Clock,
  Download,
  LayoutGrid,
  Lock,
  Minus,
  Monitor,
  Moon,
  Palette,
  Plus,
  SquareTerminal,
  Sun,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useId, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import type { ThemePreference } from '@shared/api'
import {
  ACCENTS,
  PREFERENCE_DEFAULTS,
  SECTIONS,
  TERMINAL_FONT_SIZES,
  TERMINAL_FONTS,
  TEXT_SIZES,
  type Accent,
  type Preferences,
} from '@shared/preferences'
import { Button } from '@renderer/components/Button'
import { Switch } from '@renderer/components/Switch'
import {
  useLocked,
  usePreferences,
  useSetPreferences,
  useSetTheme,
  useSettings,
} from '@renderer/hooks/settings'
import { api } from '@renderer/lib/api'
import { cn } from '@renderer/lib/cn'
import { age } from '@renderer/lib/format'
import { useLayout } from '@renderer/lib/layout'
import { localClockIs12, localZone } from '@renderer/lib/time'
import { useUi } from '@renderer/state/ui'

type Section = keyof typeof SECTIONS

const SECTION_NAMES: Record<Section, { label: string; icon: LucideIcon }> = {
  appearance: { label: 'Appearance', icon: Palette },
  time: { label: 'Time', icon: Clock },
  terminal: { label: 'Terminal', icon: SquareTerminal },
  namespaces: { label: 'Namespaces', icon: LayoutGrid },
  updates: { label: 'Updates', icon: Download },
}

const ACCENT_NAMES: Record<Accent, string> = {
  blue: 'Blue',
  cyan: 'Cyan',
  violet: 'Violet',
  graphite: 'Graphite',
}

/** Each accent's fill and label, per theme (as styles/index.css has them), for its swatch. */
const ACCENT_SWATCH: Record<Accent, { light: [string, string]; dark: [string, string] }> = {
  blue: { light: ['#2675d3', '#ffffff'], dark: ['#2675d3', '#ffffff'] },
  cyan: { light: ['#0e7490', '#ffffff'], dark: ['#0e7490', '#ffffff'] },
  violet: { light: ['#6d4fd6', '#ffffff'], dark: ['#6d4fd6', '#ffffff'] },
  graphite: { light: ['#404040', '#ffffff'], dark: ['#d4d4d4', '#0a0a0a'] },
}

const field =
  'h-8 rounded-lg border border-line-strong bg-surface px-2.5 text-[13px] text-ink-1 outline-none focus:border-accent focus:ring-3 focus:ring-accent-soft disabled:opacity-50'

/** The system's name, as Settings says "System follows macOS". */
const systemName =
  api.host === 'server'
    ? 'this device'
    : navigator.userAgent.includes('Mac')
      ? 'macOS'
      : navigator.userAgent.includes('Windows')
        ? 'Windows'
        : 'the system'

/**
 * Settings: the person's own, each applied at once, in every window, and kept (on the desktop in
 * its settings file, on a server for them). Appearance, Time, Terminal, Namespaces, and on the
 * desktop Updates; what an organization's policy (or whoever runs the server) sets, shown as it
 * is, locked. On a phone, a list of sections, each a page.
 */
export function SettingsPage() {
  useEffect(() => {
    document.title = 'Settings — Lumovi'
  }, [])
  const [params, setParams] = useSearchParams()
  const phone = useLayout() === 'phone'
  const sections = (Object.keys(SECTION_NAMES) as Section[]).filter(
    (section) => section !== 'updates' || api.updates,
  )
  const asked = params.get('section') as Section | null
  const section = asked && sections.includes(asked) ? asked : phone ? undefined : 'appearance'
  const locked = useLocked()
  const open = (next: Section | undefined) =>
    setParams(
      (current) => {
        const p = new URLSearchParams(current)
        if (next) p.set('section', next)
        else p.delete('section')
        return p
      },
      { replace: !phone },
    )
  const sectionLocked = (s: Section) => SECTIONS[s].some((key) => locked(key))
  // On a phone, a section is a page of its own: the bar's Back (where its menu is) goes to the list.
  const setInside = useUi((ui) => ui.setInside)
  const inSection = phone && section !== undefined
  useEffect(() => {
    if (!inSection) return
    setInside({ back: () => open(undefined), label: 'Back to Settings' })
    return () => setInside(undefined)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSection, setInside])

  if (phone && !section) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <nav aria-label="Settings">
          {sections
            .filter((s) => s !== 'updates')
            .map((s) => {
              const { label, icon: Icon } = SECTION_NAMES[s]
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => open(s)}
                  className="flex min-h-[52px] w-full items-center gap-3 border-b border-line px-4 text-left text-[15px]"
                >
                  <Icon className="size-[18px] text-ink-3" />
                  {label}
                  {sectionLocked(s) && <Lock className="size-3.5 text-ink-3" />}
                  <SectionSummary section={s} />
                  <ChevronRight className="size-[18px] text-ink-3" />
                </button>
              )
            })}
        </nav>
        <p className="m-4 text-[13px] leading-relaxed text-ink-3">{keptWhere()}</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1">
      {!phone && (
        <nav aria-label="Settings" className="w-[216px] shrink-0 border-r border-line px-3 py-4">
          {sections.map((s) => {
            const { label, icon: Icon } = SECTION_NAMES[s]
            return (
              <button
                key={s}
                type="button"
                aria-current={s === section ? 'page' : undefined}
                onClick={() => open(s)}
                className={cn(
                  'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-ink-2',
                  s === section ? 'bg-surface-3 font-medium text-ink-1' : 'hover:bg-surface-3/60',
                )}
              >
                <Icon className="size-4 text-ink-3" />
                {label}
                {sectionLocked(s) && (
                  <Lock
                    aria-label="Set by your organization"
                    className="ml-auto size-3 text-ink-3"
                  />
                )}
              </button>
            )
          })}
        </nav>
      )}
      <main className="min-w-0 flex-1 overflow-y-auto px-8 pt-5 pb-6 phone:px-4 phone:pt-1">
        {section && <SectionBody section={section} />}
      </main>
    </div>
  )
}

/** Where the settings are kept, as the page's foot says. */
const keptWhere = () =>
  api.host === 'server'
    ? 'Kept for you on this server: every device you sign in from shows them.'
    : 'Kept on this computer, in its settings file.'

/** What a section's set to, said in a word or two beside it on a phone. */
function SectionSummary({ section }: { section: Section }) {
  const p = usePreferences()
  const theme = useSettings().data?.theme ?? 'system'
  const said = {
    appearance: `${theme[0]!.toUpperCase()}${theme.slice(1)} · ${ACCENT_NAMES[p.accent]}`,
    time: `${p.timeZone === 'local' ? 'This phone’s' : p.timeZone} · ${p.clock === 'system' ? 'System' : `${p.clock}-hour`}`,
    terminal: `${p.terminalFont} · ${p.terminalFontSize} px`,
    namespaces:
      p.namespaces.mode === 'last'
        ? 'Last picked'
        : p.namespaces.mode === 'all'
          ? 'All'
          : p.namespaces.namespace,
    updates: '',
  }[section]
  return <span className="ml-auto truncate text-[13px] text-ink-3">{said}</span>
}

function SectionBody({ section }: { section: Section }) {
  const p = usePreferences()
  const settings = useSettings().data
  const locked = useLocked()
  const set = useSetPreferences()
  const setTheme = useSetTheme()
  const keys = SECTIONS[section]
  // What Restore would put back: what's not as its default, and not set by policy.
  const restorable = keys.filter((key) => {
    if (locked(key)) return false
    if (key === 'theme') return (settings?.theme ?? 'system') !== 'system'
    if (key === 'autoUpdate') return settings?.autoUpdate === false
    if (key === 'shell' && !api.desktop) return false
    return JSON.stringify(p[key]) !== JSON.stringify(PREFERENCE_DEFAULTS[key])
  })
  const restore = async () => {
    const patch: Record<string, null> = {}
    for (const key of restorable) {
      if (key === 'theme') continue
      patch[key] = null
    }
    if (restorable.includes('theme')) await setTheme('system')
    if (Object.keys(patch).length) await set(patch)
  }
  const { label } = SECTION_NAMES[section]
  const lead = {
    appearance: 'Applied at once, in every window.',
    time: 'How times and dates are shown. Ages (“2h”, “3d”) are the same everywhere.',
    terminal: 'For every terminal in the dock. Open ones change at once.',
    namespaces: 'Which namespace a cluster opens in.',
    updates: 'On this computer.',
  }[section]
  return (
    // (Narrower than 720 px, each setting's name goes above its control: see Setting.)
    <section aria-label={label} className="@container">
      <h2 className="text-[17px] leading-6 font-semibold tracking-[-0.01em] text-ink-1">{label}</h2>
      <p className="mb-4 text-[13px] text-ink-3">{lead}</p>
      {section === 'appearance' && <Appearance />}
      {section === 'time' && <Time />}
      {section === 'terminal' && <Terminal />}
      {section === 'namespaces' && <Namespaces />}
      {section === 'updates' && <Updates />}
      <p className="mt-4 flex flex-wrap items-center gap-2.5 text-xs text-ink-3">
        {keptWhere()}
        {restorable.length > 0 && (
          <button
            type="button"
            onClick={() => void restore()}
            className="font-medium text-accent-strong hover:underline phone:flex phone:h-11 phone:items-center phone:text-[15px]"
          >
            Restore this section’s defaults
          </button>
        )}
      </p>
    </section>
  )
}

/** A setting: its name (and what it is), its control, and a line under it; locked, said so. */
function Setting({
  name,
  sub,
  line,
  locked,
  children,
}: {
  name: string
  sub?: string
  line?: ReactNode
  locked?: boolean
  children: ReactNode
}) {
  const id = useId()
  return (
    <div
      role="group"
      aria-labelledby={`${id}-name`}
      className="grid grid-cols-1 items-start gap-x-6 gap-y-1 border-t border-line py-3.5 @min-[720px]:grid-cols-[200px_minmax(0,1fr)]"
    >
      <div>
        <span id={`${id}-name`} className="block text-[13px] font-medium text-ink-1">
          {name}
        </span>
        {sub && <span className="mt-0.5 block text-xs leading-[17px] text-ink-3">{sub}</span>}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {locked && (
          <span className="text-xs leading-[17px] text-ink-2">
            <Lock className="mr-1 inline size-3 align-[-2px]" />
            Set by your organization
          </span>
        )}
        <div className={cn('flex min-w-0 flex-col gap-1.5', locked && 'opacity-50')}>
          {children}
        </div>
        {line && <span className="text-xs leading-[17px] text-ink-3">{line}</span>}
      </div>
    </div>
  )
}

/** A choice of a few, side by side. */
function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string; icon?: LucideIcon }[]
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <span
      role="radiogroup"
      aria-label={label}
      className="inline-flex self-start rounded-lg bg-surface-3 p-0.5"
    >
      {options.map((option) => {
        const on = option.value === value
        const Icon = option.icon
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => !on && onChange(option.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-[5px] text-[13px] text-ink-2 phone:px-3.5 phone:py-2.5 phone:text-[15px]',
              on && 'bg-surface text-ink-1 shadow-sm',
            )}
          >
            {Icon && <Icon className="size-3.5 text-ink-3" />}
            {option.label}
          </button>
        )
      })}
    </span>
  )
}

/** − value + */
function Stepper({
  label,
  value,
  said,
  canLess,
  canMore,
  disabled,
  onLess,
  onMore,
}: {
  label: string
  value: string
  said?: string
  canLess: boolean
  canMore: boolean
  disabled?: boolean
  onLess: () => void
  onMore: () => void
}) {
  const step = 'grid min-w-8 place-items-center px-2 text-ink-2 disabled:opacity-40 phone:min-w-11'
  return (
    // (Named by its setting: its buttons say what they change.)
    <span className="inline-flex h-[30px] items-center self-start rounded-lg border border-line-strong bg-surface phone:h-11">
      <button
        type="button"
        aria-label={`Smaller ${label.toLowerCase()}`}
        disabled={disabled || !canLess}
        onClick={onLess}
        className={cn(step, 'h-full')}
      >
        <Minus className="size-3.5" />
      </button>
      <span
        aria-live="polite"
        aria-label={said ?? value}
        className="grid h-full min-w-16 place-items-center border-x border-line text-[13px] text-ink-1 tabular-nums"
      >
        {value}
      </span>
      <button
        type="button"
        aria-label={`Larger ${label.toLowerCase()}`}
        disabled={disabled || !canMore}
        onClick={onMore}
        className={cn(step, 'h-full')}
      >
        <Plus className="size-3.5" />
      </button>
    </span>
  )
}

/** Which theme the system's is now. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const changed = () => setDark(media.matches)
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  return dark
}

function Appearance() {
  const p = usePreferences()
  const locked = useLocked()
  const set = useSetPreferences()
  const setTheme = useSetTheme()
  const theme = useSettings().data?.theme ?? 'system'
  const systemDark = useSystemDark()
  const dark = theme === 'dark' || (theme === 'system' && systemDark)
  const sizeAt = (TEXT_SIZES as readonly number[]).indexOf(p.textSize)
  const phone = useLayout() === 'phone'
  const mod = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl+'
  return (
    <>
      <Setting
        name="Theme"
        locked={locked('theme')}
        line={
          theme === 'system'
            ? `System follows ${systemName}: ${systemDark ? 'dark' : 'light'} now.`
            : undefined
        }
      >
        <Segmented<ThemePreference>
          label="Theme"
          value={theme}
          disabled={locked('theme')}
          onChange={(next) => void setTheme(next)}
          options={[
            { value: 'system', label: 'System', icon: Monitor },
            { value: 'light', label: 'Light', icon: Sun },
            { value: 'dark', label: 'Dark', icon: Moon },
          ]}
        />
      </Setting>
      <Setting
        name="Accent"
        sub="Buttons, links and what’s picked."
        locked={locked('accent')}
        line={`${ACCENT_NAMES[p.accent]}. Statuses keep their own colours: no accent is red, amber or green.`}
      >
        <span role="radiogroup" aria-label="Accent" className="flex gap-2 phone:gap-3">
          {ACCENTS.map((accent) => {
            const [fill, label] = ACCENT_SWATCH[accent][dark ? 'dark' : 'light']
            const on = accent === p.accent
            return (
              <button
                key={accent}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={ACCENT_NAMES[accent]}
                title={ACCENT_NAMES[accent]}
                disabled={locked('accent')}
                onClick={() => !on && void set({ accent })}
                style={{
                  background: fill,
                  color: label,
                  ...(on ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${fill}` } : {}),
                }}
                className="grid size-[26px] place-items-center rounded-full phone:size-9"
              >
                {on && (
                  <svg
                    viewBox="0 0 24 24"
                    className="size-3.5"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={3}
                    aria-hidden
                  >
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                )}
              </button>
            )
          })}
        </span>
      </Setting>
      <Setting
        name="Density"
        sub="How much fits in a list."
        locked={locked('density')}
        line={
          phone
            ? 'On a phone, rows stay large enough for a finger.'
            : 'Compact rows are 36 px, from 46.'
        }
      >
        <Segmented<Preferences['density']>
          label="Density"
          value={p.density}
          disabled={locked('density')}
          onChange={(density) => void set({ density })}
          options={[
            { value: 'comfortable', label: 'Comfortable' },
            { value: 'compact', label: 'Compact' },
          ]}
        />
      </Setting>
      <Setting
        name="Text size"
        locked={locked('textSize')}
        line={
          api.desktop
            ? `90% to 125%. ${mod}+ and ${mod}− change it too, and ${mod}0 puts it back.`
            : '90% to 125%.'
        }
      >
        <Stepper
          label="Text size"
          value={`${p.textSize}%`}
          disabled={locked('textSize')}
          canLess={sizeAt > 0}
          canMore={sizeAt < TEXT_SIZES.length - 1}
          onLess={() => void set({ textSize: TEXT_SIZES[sizeAt - 1] })}
          onMore={() => void set({ textSize: TEXT_SIZES[sizeAt + 1] })}
        />
      </Setting>
    </>
  )
}

/** Every zone this runtime knows, by name. */
const ZONES: string[] = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf(key: string): string[] }).supportedValuesOf(
      'timeZone',
    )
  } catch {
    return []
  }
})()

function Time() {
  const p = usePreferences()
  const locked = useLocked()
  const set = useSetPreferences()
  const phone = useLayout() === 'phone'
  const here = api.host !== 'server' ? 'This computer’s' : phone ? 'This phone’s' : 'This device’s'
  return (
    <>
      <Setting
        name="Time zone"
        locked={locked('timeZone')}
        line="Or UTC, or any zone: events, logs and audit read in it."
      >
        <select
          aria-label="Time zone"
          value={p.timeZone}
          disabled={locked('timeZone')}
          onChange={(event) => void set({ timeZone: event.target.value })}
          className={cn(field, 'w-full max-w-md self-start')}
        >
          <option value="local">
            {here} ({localZone()})
          </option>
          <option value="UTC">UTC</option>
          {ZONES.filter((zone) => zone !== 'UTC').map((zone) => (
            <option key={zone} value={zone}>
              {zone.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      </Setting>
      <Setting
        name="Clock"
        locked={locked('clock')}
        line={
          p.clock === 'system'
            ? `System: ${localClockIs12() ? '12-hour' : '24-hour'} now, as ${systemName} has it.`
            : undefined
        }
      >
        <Segmented<Preferences['clock']>
          label="Clock"
          value={p.clock}
          disabled={locked('clock')}
          onChange={(clock) => void set({ clock })}
          options={[
            { value: 'system', label: 'System' },
            { value: '12', label: '12-hour' },
            { value: '24', label: '24-hour' },
          ]}
        />
      </Setting>
    </>
  )
}

function Terminal() {
  const p = usePreferences()
  const locked = useLocked()
  const set = useSetPreferences()
  const fonts = TERMINAL_FONTS.includes(p.terminalFont)
    ? TERMINAL_FONTS
    : [p.terminalFont, ...TERMINAL_FONTS]
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono')
  const family = p.terminalFont === 'JetBrains Mono' ? mono : `'${p.terminalFont}', ${mono}`
  const copy = navigator.userAgent.includes('Mac') ? '⌘C' : 'Ctrl+Shift+C'
  return (
    <>
      <Setting name="Font" locked={locked('terminalFont') || locked('terminalFontSize')}>
        <span className="flex flex-wrap gap-2">
          <select
            aria-label="Terminal font"
            value={p.terminalFont}
            disabled={locked('terminalFont')}
            onChange={(event) => void set({ terminalFont: event.target.value })}
            className={cn(field, 'w-52 font-mono text-[12.5px]')}
          >
            {fonts.map((font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ))}
          </select>
          <Stepper
            label="Terminal font size"
            value={`${p.terminalFontSize} px`}
            disabled={locked('terminalFontSize')}
            canLess={p.terminalFontSize > TERMINAL_FONT_SIZES.min}
            canMore={p.terminalFontSize < TERMINAL_FONT_SIZES.max}
            onLess={() => void set({ terminalFontSize: p.terminalFontSize - 1 })}
            onMore={() => void set({ terminalFontSize: p.terminalFontSize + 1 })}
          />
        </span>
        <pre
          aria-label="Terminal preview"
          style={{ fontFamily: family, fontSize: p.terminalFontSize, lineHeight: 1.25 }}
          className="overflow-x-auto rounded-[10px] border border-line bg-[#0d0d0d] px-3 py-2.5 text-[#ededed]"
        >
          <span className="text-[#8f8f8f]">~ ›</span> kubectl get pods -n shop{'\n'}
          {'NAME                      READY   STATUS\n'}
          {'checkout-7d9f6c5b8-hqnnn  0/1     CrashLoopBackOff'}
        </pre>
      </Setting>
      <Setting name="Copy on select" locked={locked('copyOnSelect')}>
        <label className="flex items-start gap-2.5">
          <Switch
            label="Copy what I select"
            checked={p.copyOnSelect}
            locked={locked('copyOnSelect')}
            onCheckedChange={(copyOnSelect) => void set({ copyOnSelect })}
          />
          <span>
            <span className="block text-[13px] font-medium text-ink-1">Copy what I select</span>
            <span className="block text-xs text-ink-3">
              {p.copyOnSelect
                ? 'On: what you select is copied at once.'
                : `Off: select, then ${copy}, as a terminal does by default.`}
            </span>
          </span>
        </label>
      </Setting>
      {api.app.shells && <Shell />}
    </>
  )
}

/** The desktop's shell: the login one, another this computer lists, or a path. */
function Shell() {
  const p = usePreferences()
  const locked = useLocked()
  const set = useSetPreferences()
  const shells = useQuery({ queryKey: ['shells'], queryFn: () => api.app.shells!() }).data
  const [typing, setTyping] = useState<string>()
  const listed = shells?.shells ?? []
  const other = p.shell !== '' && !listed.includes(p.shell)
  return (
    <Setting
      name="Shell"
      sub="The program a terminal starts."
      locked={locked('shell')}
      line="Or another shell this computer has, or a path. It starts with kubectl pointed at the terminal’s cluster, whichever shell it is."
    >
      <select
        aria-label="Shell"
        value={typing !== undefined || other ? 'other' : p.shell === '' ? '' : p.shell}
        disabled={locked('shell')}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'other') setTyping(p.shell)
          else {
            setTyping(undefined)
            void set({ shell: value === shells?.login ? '' : value })
          }
        }}
        className={cn(field, 'w-72 max-w-full self-start font-mono text-[12.5px]')}
      >
        <option value="">
          {shells ? `${shells.login} (your login shell)` : 'Your login shell'}
        </option>
        {listed
          .filter((shell) => shell !== shells?.login)
          .map((shell) => (
            <option key={shell} value={shell}>
              {shell}
            </option>
          ))}
        <option value="other">Another…</option>
      </select>
      {(typing !== undefined || other) && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            const path = (typing ?? p.shell).trim()
            void set({ shell: path }).then((ok) => ok && setTyping(undefined))
          }}
        >
          <input
            aria-label="Shell’s path"
            value={typing ?? p.shell}
            placeholder="/opt/homebrew/bin/fish"
            onChange={(event) => setTyping(event.target.value)}
            spellCheck={false}
            className={cn(field, 'w-72 max-w-full font-mono text-[12.5px]')}
          />
          <Button type="submit" variant="secondary" className="h-8">
            Use it
          </Button>
        </form>
      )}
    </Setting>
  )
}

function Namespaces() {
  const p = usePreferences()
  const locked = useLocked()
  const set = useSetPreferences()
  const [named, setNamed] = useState(
    p.namespaces.mode === 'named' ? p.namespaces.namespace : 'default',
  )
  const radio = (mode: Preferences['namespaces']['mode'], label: ReactNode, extra?: ReactNode) => (
    <label className="flex items-center gap-2.5 text-[13px] text-ink-1">
      <input
        type="radio"
        name="namespaces"
        checked={p.namespaces.mode === mode}
        disabled={locked('namespaces')}
        onChange={() =>
          void set({ namespaces: mode === 'named' ? { mode, namespace: named } : { mode } })
        }
        className="accent-[var(--accent)]"
      />
      {label}
      {extra}
    </label>
  )
  return (
    <Setting
      name="When a cluster opens"
      locked={locked('namespaces')}
      line="Where a cluster’s own settings name a namespace, that wins."
    >
      <div role="radiogroup" aria-label="When a cluster opens" className="flex flex-col gap-2">
        {radio('all', 'All namespaces')}
        {radio(
          'last',
          <>
            The one I last picked there
            <span className="text-xs text-ink-3">as now</span>
          </>,
        )}
        {radio(
          'named',
          'This one',
          <input
            aria-label="Namespace a cluster opens in"
            value={named}
            disabled={locked('namespaces')}
            onChange={(event) => setNamed(event.target.value.trim())}
            onBlur={() => {
              if (p.namespaces.mode === 'named' && named && named !== p.namespaces.namespace) {
                void set({ namespaces: { mode: 'named', namespace: named } })
              }
            }}
            spellCheck={false}
            className={cn(field, 'h-7 w-40 font-mono text-xs')}
          />,
        )}
      </div>
    </Setting>
  )
}

function Updates() {
  const settings = useSettings().data
  const locked = useLocked()
  const set = useSetPreferences()
  const state = useQuery({ queryKey: ['update-state'], queryFn: () => api.updates!.state() })
  const [checkedAt, setCheckedAt] = useState<string>()
  useEffect(
    () =>
      api.updates!.onChange((event) => {
        state.refetch()
        if (event.state.status !== 'checking') setCheckedAt(new Date().toISOString())
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const version = useQuery({ queryKey: ['app-info'], queryFn: () => api.app.info() }).data?.version
  const status = state.data?.state
  return (
    <>
      <Setting name="Check automatically" locked={locked('autoUpdate')}>
        <label className="flex items-start gap-2.5">
          <Switch
            label="Check for updates"
            checked={settings?.autoUpdate !== false}
            locked={locked('autoUpdate')}
            onCheckedChange={(autoUpdate) => void set({ autoUpdate })}
          />
          <span>
            <span className="block text-[13px] font-medium text-ink-1">Check for updates</span>
            <span className="block text-xs text-ink-3">
              Once a day, from lumovi.dev. An update asks before it installs.
            </span>
          </span>
        </label>
      </Setting>
      <Setting name="This version">
        <span className="flex flex-wrap items-center gap-2.5 text-[13px] text-ink-2">
          Lumovi {version}
          {checkedAt && ` · checked ${age(checkedAt)} ago`}
          {status?.status === 'up-to-date' && ' · up to date'}
          {status?.status === 'ready' && ` · ${status.version} is ready to install`}
          <Button
            variant="secondary"
            className="h-7 px-2.5 text-xs"
            disabled={status?.status === 'checking'}
            onClick={() => void api.updates!.check()}
          >
            Check now
          </Button>
        </span>
      </Setting>
    </>
  )
}
