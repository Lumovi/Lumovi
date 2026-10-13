- **Developer mode** runs code from plugins of your own. With it on, at the foot of the Plugins
  page, a plugin that is a folder of its own in your plugins folder (`<name>/plugin.yaml` and
  `<name>/plugin.js`) draws its pages in Lumovi's sealed box, as Lumovi's own and installed ones
  do, once you've seen what it may do and agreed. New code asks again with one press; a file
  that asks for more asks again with what's new. Off, which is how it starts, a folder's code
  isn't read at all. An organization's policy can keep it off (`pluginDeveloperMode: off`, or
  `plugins` set to `bundled`, `off` or `no-code`), and then lets go of what was agreed.
