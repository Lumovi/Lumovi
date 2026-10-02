import type { KubestacksApi } from '../shared/api'

declare global {
  interface Window {
    /** The desktop app's preload script sets it; a served page, lib/api.ts. */
    kubestacks?: KubestacksApi
  }
}
