# The plugins' CRDs: not here

Lumovi-plugins keeps each plugin's CRDs beside it, and its check puts them here, in a checkout of
Lumovi, with `sources.json`, to run Lumovi's own checker on its plugins
(`tests/plugins/plugins.spec.ts`, fetched by `scripts/crds.ts`). In Lumovi itself this folder
holds nothing but this file, and the checker refuses anything else here.
