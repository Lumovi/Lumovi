import { useEffect, useState } from 'react'

/**
 * How long a confirmation's button can't be pressed after it's shown, or after what it confirms
 * changes: a press or a tap meant for what was there a moment ago (the pill, the request before,
 * a plugin's page under the pointer) confirms nothing. A press in that time is dropped, not kept
 * for after. The assistants' approval sheet, a plugin's proposed change and a shell a plugin's
 * link opened share it.
 */
export const APPROVE_MOMENT_MS = 600

/**
 * Whether the moment has passed since `on` was shown (a new answer starts it again, and so does
 * Lumovi's window getting the focus back): counted from the frame that paints it, only while the
 * window is in front. A press before then is dropped, not kept.
 */
export function useMoment(on: string | undefined): boolean {
  // (Live for what was shown when its moment ran out: anything shown since, or a focus got back
  // since, is a new moment.)
  const [liveFor, setLiveFor] = useState<string>()
  const [back, setBack] = useState(0)
  useEffect(() => {
    const focused = () => setBack((n) => n + 1)
    window.addEventListener('focus', focused)
    return () => window.removeEventListener('focus', focused)
  }, [])
  const now = on === undefined ? undefined : `${on}\u0000${back}`
  useEffect(() => {
    if (now === undefined) return
    let timer: ReturnType<typeof setTimeout> | undefined
    const frame = requestAnimationFrame(() => {
      timer = setTimeout(() => document.hasFocus() && setLiveFor(now), APPROVE_MOMENT_MS)
    })
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(timer)
    }
  }, [now])
  return now !== undefined && liveFor === now
}
