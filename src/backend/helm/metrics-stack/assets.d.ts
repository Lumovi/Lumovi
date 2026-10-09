// The chart and its values, built into Lumovi (Vite's ?inline and ?raw).
declare module '*.tgz?inline' {
  /** A data: URL of the file's bytes, in base64. */
  const url: string
  export default url
}
declare module '*.yaml?raw' {
  const text: string
  export default text
}
