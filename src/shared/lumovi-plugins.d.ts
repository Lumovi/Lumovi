/**
 * The plugins Lumovi comes with: each plugin's file, by its file name ("karpenter.yaml"), from the
 * bundle plugins.lock.json pins, as the build checked it (scripts/vite-plugins.ts).
 */
declare module 'virtual:lumovi-plugins' {
  const files: Readonly<Record<string, string>>
  export default files
  /** The code beside a plugin's file, by its own file name ("karpenter.js"); none where it has none. */
  export const code: Readonly<Record<string, string>>
}
