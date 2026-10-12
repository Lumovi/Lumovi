- **YAML is checked against the cluster's schema as it's typed**, in **Create…** (its YAML and
  the form's) and when an object's YAML tab edits it. What the cluster would refuse (YAML it
  can't read, a value of the wrong type or not among those allowed, a required field left out)
  is marked as an error. What it would drop without saying so (a field the kind doesn't have,
  with the one meant where one is close) is marked as a warning. A card under the pointer says
  what's wrong, a line under the editor counts the problems, F8 and ⇧F8 go from one to the next,
  and ⌥F8 lists them. Typing a key, ⌃Space or ⌥Esc offers the fields that fit there, required
  ones first, and after a colon the values a field allows. Pointing at a field, or ⌥F1, shows
  what the schema says of it (⌥ is Alt on Windows and Linux). A custom resource is checked by
  its CRD's schema; where the cluster publishes none, only the YAML itself is checked, and a line
  says so. Nothing here stops a save: the cluster checks the YAML before anything changes. In
  YAML, viewed or edited, a character that can't be seen or would turn a line round shows as a
  placeholder, never as itself.
