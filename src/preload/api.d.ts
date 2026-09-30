import type { KubestacksApi } from '../shared/api'

declare global {
  interface Window {
    kubestacks: KubestacksApi
  }
}
