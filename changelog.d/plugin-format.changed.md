- A plugin's file says more about itself, and is checked harder. It starts
  `apiVersion: lumovi.dev/v1beta1` and names its `version`, the oldest Lumovi it works with
  (`needs.lumovi`) and the API groups its kinds are in (`groups`). A name is lowercase letters,
  digits and hyphens. An action that changes something without asking first
  says `runs: at-once`. Refused, each with its reason on the API resources page: two views of one
  kind in a plugin; a second file with a name another has (the first is used); a patch that
  changes what's the cluster's to set (an object's owners, finalizers, name or namespace); a
  text that's too long or holds characters nobody can see; and a plugin that needs a newer
  Lumovi than this one.
