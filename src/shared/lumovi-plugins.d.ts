/**
 * The plugins Lumovi comes with: each plugin's file, by its file name ("karpenter.yaml"), from the
 * bundle plugins.lock.json pins, as the build checked it (scripts/vite-plugins.ts).
 */
declare module 'virtual:lumovi-plugins' {
  const files: Readonly<Record<string, string>>
  export default files
}
