/**
 * How long a confirmation's button can't be pressed after it's shown, or after what it confirms
 * changes: a press or a tap meant for what was there a moment ago (the pill, the request before,
 * a plugin's page under the pointer) confirms nothing. A press in that time is dropped, not kept
 * for after. The assistants' approval sheet and a plugin's proposed change share it.
 */
export const APPROVE_MOMENT_MS = 600
