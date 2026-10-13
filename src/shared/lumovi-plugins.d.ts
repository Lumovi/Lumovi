/**
 * The plugins Lumovi comes with: each plugin's file, by its file name ("karpenter.yaml"), from the
 * bundle plugins.lock.json pins, as the build checked it (scripts/vite-plugins.ts).
 */
declare module 'virtual:lumovi-plugins' {
  const files: Readonly<Record<string, string>>
  export default files
}

/**
 * The code beside them, by its own file name ("karpenter.js"); none where a plugin has none. In
 * the backend's builds alone: the page's refuses it.
 */
declare module 'virtual:lumovi-plugins/code' {
  const code: Readonly<Record<string, string>>
  export default code
}

/**
 * The names of the plugins whose code comes with them ("karpenter"), and none of their code: what
 * the page needs to know which of them have pages it may offer.
 */
declare module 'virtual:lumovi-plugins/coded' {
  const names: readonly string[]
  export default names
}

/**
 * Which release of Lumovi-plugins they're from: its version, and its serial, which a later
 * release's is never lower than.
 */
declare module 'virtual:lumovi-plugins/release' {
  const release: Readonly<{ version: string; serial: number }>
  export default release
}
