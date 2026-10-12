# Lumovi's plugins: not here

The plugins Lumovi comes with live in [Lumovi-plugins](https://github.com/Lumovi/Lumovi-plugins),
and Lumovi is built with the release `plugins.lock.json` names, checked again as it's taken
(`scripts/plugins-bundle.ts`).

This folder is where Lumovi-plugins' check puts its plugins, in a checkout of Lumovi, to run
Lumovi's own checker on them (`tests/plugins/plugins.spec.ts`). In Lumovi itself it holds nothing
but this file, and the checker refuses anything else here.
