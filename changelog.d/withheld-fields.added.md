- **Fields a plugin withholds.** A view in a plugin's file can name fields of its own kinds that
  Lumovi never shows or hands on (`withholds`), like the line around a secret a scanner found.
  They're taken out before anything leaves Lumovi's backend: lists and their CSV, an object's YAML
  and its copy, its Map and Audit tabs, a plugin's code, and AI assistants' tools. The YAML tab
  says which fields are withheld, and whose file withholds them. Such an object isn't edited whole
  in Lumovi, nor patched where a change would touch them: use kubectl. Every plugin file Lumovi
  has counts, whether or not its plugin is shown or allowed.
