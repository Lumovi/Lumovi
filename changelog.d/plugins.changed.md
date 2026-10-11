- Add-ons are **plugins**, and a tool's file is one thing: a plugin, with its place in the
  sidebar and, inside it, a view for each kind it shows. The sidebar's section, the command
  palette and the API resources page say Plugins: that page counts them and names the plugin that
  shows each kind, and a plugin's own page is at `…/plugins/<name>`. Your own go in
  `~/.lumovi/plugins` (or the folder `LUMOVI_PLUGINS_DIR` names; a server's in
  `/etc/lumovi/plugins`, from the Helm chart's `plugins`), one `kind: Plugin` a file with its
  views under `views:`. A file is used whole or not at all, and everything wrong with it is
  listed, where a part of a file used to be dropped by itself; when that leaves one of Lumovi's
  plugins in use in place of yours, the page says so. The command palette's field says
  "Jump to a page…", so that "view" means one thing in Lumovi: a part of a plugin.
