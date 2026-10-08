In dark mode, white on the accent (Blue 500, #3987e5) was 3.64:1, under the 4.5:1 a button's text needs, and hovered it went lighter (#5ea2f0, 2.66:1). The brand's fix (Lumovi-design 6fad7ac, guidelines → Buttons) is Blue 600 in both modes, with the hover deepening.

## What changed

- **`styles/index.css`:**
  - Dark `--accent`: #3987e5 → **#2675d3**, Blue 600 as in light.
  - New `--accent-hover` (#1c5cab, Blue 700) and `--critical-hover` (#bb3535). They're set once on `:root`, so they apply in both modes; dark mode overrides neither.
  - Their `@theme` colours, `--color-accent-hover` and `--color-critical-hover`.
  - `--accent-soft` and `--accent-track` are unchanged, as asked.
- **`components/Button.tsx`:** primary hovers to `bg-accent-hover` (was `bg-accent-strong`, which in dark is the lighter #5ea2f0), and danger to `bg-critical-hover` (was `bg-critical/90`, lighter on dark surfaces).
- **Nothing else:** the skip link and the map's focused chip use `bg-accent text-white` and follow the token. The other `hover:bg-critical/…` uses are tinted text-on-surface hovers, not white on a fill.
- **CHANGELOG** [Unreleased] line.

## Contrast (white text)

| | Before (dark) | After (both modes) |
| --- | --- | --- |
| Primary | 3.64:1 (#3987e5) | **4.60:1** (#2675d3) |
| Primary, hovered | 2.66:1 (#5ea2f0) | **6.63:1** (#1c5cab) |
| Danger | 4.80:1 (#d03b3b) | 4.80:1 (unchanged) |
| Danger, hovered | lighter (`critical/90` on the surface) | **5.72:1** (#bb3535) |

## Screenshots

Primary (Scale) and danger (Delete), at rest and hovered:

| | Light | Dark |
| --- | --- | --- |
| Primary, at rest | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/primary-rest-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/primary-rest-dark.webp) |
| Primary, hovered | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/primary-hover-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/primary-hover-dark.webp) |
| Danger, at rest | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/danger-rest-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/danger-rest-dark.webp) |
| Danger, hovered | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/danger-hover-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/danger-hover-dark.webp) |

The delete dialog on the page, Delete hovered:

| | Light | Dark |
| --- | --- | --- |
| 1440 | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/window-1440-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/window-1440-dark.webp) |
| 1024 | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/window-1024-light.webp) | ![](https://raw.githubusercontent.com/Lumovi/Lumovi/pr-assets/lmv-73/window-1024-dark.webp) |

**Done when**
- [x] Primary and danger buttons, at rest and hovered, in both themes, are screenshotted here.
- [ ] CI is green, then merged.
