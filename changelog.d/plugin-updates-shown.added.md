- **The Plugins page says which plugins have a newer version.** When you open it, or press
  **Check now**, the desktop app looks at Lumovi-plugins' latest release, and takes it only if
  it's signed by that repository's release workflow, built from its tag's commit, no older than
  one it already took, and not expired. A plugin with a newer one says so, or which Lumovi it
  needs, and **Not here yet** lists the plugins this Lumovi doesn't have, with what each would
  ask. An organization's policy can turn it off (`pluginStore: off`; `plugins: bundled` or `off`
  do too).
