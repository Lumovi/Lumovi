/**
 * The catalog of the screenshots: README.md, to browse them and learn how to
 * use them, and screenshots.json, for the website and docs to read.
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import prettier from 'prettier'
import { filesOf, HEIGHT, WIDTH } from './images.ts'
import type { Screen } from './screens.ts'

/** Where the website and docs load them from: jsDelivr, serving this repository's main. */
export const CDN = 'https://cdn.jsdelivr.net/gh/KubeStacks/KubeStacks@main/docs/screenshots/'

const both = (name: string) => ({ light: filesOf(name, 'light'), dark: filesOf(name, 'dark') })

function readme(screens: Screen[]): string {
  const example = both('overview')
  const gallery = screens.map((screen) => {
    const { light, dark } = both(screen.name)
    const image = (files: typeof light) =>
      `[![${screen.description}](${files['1x']})](${files['2x']})`
    return `### ${screen.title}

\`${screen.name}\`${screen.app === 'server' ? ', served from a cluster' : ''}: ${screen.description}

| Light | Dark |
| --- | --- |
| ${image(light)} | ${image(dark)} |
`
  })
  return `<!-- Written by npm run screenshots (scripts/screenshots/): change it there. -->

# Screenshots

Every screen of KubeStacks worth showing, light and dark, for the README, the docs and the website. They're taken of the mock clusters the tests use, so they're the same every time, and refreshing them changes only the screens that did.

## Using them

Each comes as WebP in two sizes:

| File | Size |
| --- | --- |
| \`<name>-<theme>.webp\` | ${WIDTH * 2} × ${HEIGHT * 2}, lossless, for high-density screens |
| \`<name>-<theme>-1x.webp\` | ${WIDTH} × ${HEIGHT}, near-lossless |

Names don't change, so a link keeps showing the latest screenshot. In this repository, link to the file itself. Elsewhere, link to [jsDelivr](https://www.jsdelivr.com), which serves this repository's \`main\` (its cache is cleared for every screenshot that changes there):

\`\`\`
${CDN}${example.dark['2x']}
\`\`\`

To show the reader's theme, at their screen's density:

\`\`\`html
<picture>
  <source
    media="(prefers-color-scheme: dark)"
    srcset="${CDN}${example.dark['1x']} ${WIDTH}w, ${CDN}${example.dark['2x']} ${WIDTH * 2}w"
  />
  <img
    src="${CDN}${example.light['1x']}"
    srcset="${CDN}${example.light['1x']} ${WIDTH}w, ${CDN}${example.light['2x']} ${WIDTH * 2}w"
    width="${WIDTH}"
    height="${HEIGHT}"
    alt="${screens.find((s) => s.name === 'overview')?.description ?? ''}"
  />
</picture>
\`\`\`

[\`screenshots.json\`](screenshots.json) lists them all, with their titles and descriptions (good alt text).

## Taking them again

The **Screenshots** workflow (Actions → Screenshots → Run workflow) takes them all on macOS and proposes the ones that changed in a pull request. Or, on a Mac:

\`\`\`sh
npm run screenshots                    # all of them
npm run screenshots -- overview pods   # only these
npm run screenshots -- --prune         # and remove ones no longer taken
\`\`\`

Screens are listed in [\`scripts/screenshots/screens.ts\`](../../scripts/screenshots/screens.ts): a name, a description, where to start and what to do there. Once published, keep a screen's name: the website and docs link to it.

## All of them

${gallery.join('\n')}`
}

function manifest(screens: Screen[]) {
  return {
    url: CDN,
    width: WIDTH,
    height: HEIGHT,
    screenshots: screens.map(({ name, title, description, app }) => ({
      name,
      title,
      description,
      app,
      ...both(name),
    })),
  }
}

/** Writes README.md and screenshots.json into `dir`, formatted as the repository is. */
export async function writeCatalog(dir: string, screens: Screen[]): Promise<void> {
  for (const [file, text] of [
    ['README.md', readme(screens)],
    ['screenshots.json', JSON.stringify(manifest(screens))],
  ] as const) {
    const path = join(dir, file)
    const options = await prettier.resolveConfig(path)
    writeFileSync(path, await prettier.format(text, { ...options, filepath: path }))
  }
}
