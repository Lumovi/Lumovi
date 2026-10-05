"""
Makes the terminals' icon font, src/renderer/src/assets/fonts/terminal-symbols.woff2:
Nerd Fonts' Symbols Nerd Font Mono (the icons prompts draw, from Starship,
Powerlevel10k, oh-my-posh…), sized to JetBrains Mono's cells, so a prompt shows
as it does in the person's own terminal, whatever fonts they have.

Its icons are drawn for square cells, a font's em wide; a terminal's cells are
JetBrains Mono's, 0.6 em wide. So, as Nerd Fonts' own Mono fonts are made:
icons are scaled to the cell's width and centred on its line; Powerline's
separators are stretched to fill the cell, so that a prompt's segments join.

Run it again for a newer Nerd Fonts, from its NerdFontsSymbolsOnly archive:

  pip install fonttools brotli
  python3 scripts/terminal-symbols.py path/to/SymbolsNerdFontMono-Regular.ttf

and update the version in terminal-symbols.NOTICE.txt. It prints the code
points the font has, for the unicode-range in features/terminal/terminal.css.
"""

import sys
from pathlib import Path

from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
MONO = ROOT / 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'
OUTPUT = ROOT / 'src/renderer/src/assets/fonts/terminal-symbols.woff2'
FAMILY = 'Lumovi Terminal Symbols'

# Powerline's separators, which fill their cell (not its branch, line and lock icons, U+E0A0–E0A3,
# nor the wider flames, pixels and waves, which keep their shape).
SEPARATORS = set(range(0xE0B0, 0xE0C0)) | {0xE0D2, 0xE0D4}
# The heavy angle brackets (❬❭❮❯❰❱), which prompts write as text (Starship's ❯): drawn as letters
# are, already narrower than a cell, so they keep their size.
TEXT = set(range(0x276C, 0x2772))
# How far past the cell's edges a separator reaches, of its width (or height).
OVERLAP = 0.02
# Unicode's Private Use Areas, where Nerd Fonts' icons are.
PRIVATE = [(0xE000, 0xF8FF), (0xF0000, 0xFFFFD), (0x100000, 0x10FFFD)]


def main(source: str) -> None:
    font = TTFont(source, recalcTimestamp=False)
    mono = TTFont(MONO)
    # Not the outlines, which compress best as they are, but the em: as many units more as make
    # this font's (square) cells JetBrains Mono's width.
    units = font['head'].unitsPerEm
    cell = mono['hmtx'][mono.getBestCmap()[ord('M')]][0] / mono['head'].unitsPerEm
    em = round(units / cell)
    font['head'].unitsPerEm = em
    width = units
    # JetBrains Mono's line, in these units; and this font's own.
    ascent = mono['hhea'].ascent / mono['head'].unitsPerEm * em
    descent = mono['hhea'].descent / mono['head'].unitsPerEm * em
    top, bottom = font['hhea'].ascent, font['hhea'].descent

    glyf, hmtx = font['glyf'], font['hmtx']
    separators = {name for code, name in font.getBestCmap().items() if code in SEPARATORS}
    text = {name for code, name in font.getBestCmap().items() if code in TEXT}
    for name in font.getGlyphOrder():
        glyph = glyf[name]
        if glyph.numberOfContours <= 0:
            continue
        if name in separators:
            # Its outline onto the whole cell, a little past each edge (no hairline gaps
            # between it and its segment's background).
            left, right = -width * OVERLAP, width * (1 + OVERLAP)
            low = descent - (ascent - descent) * OVERLAP
            high = ascent + (ascent - descent) * OVERLAP
            sx = (right - left) / (glyph.xMax - glyph.xMin)
            sy = (high - low) / (glyph.yMax - glyph.yMin)
            glyph.coordinates.transform(((sx, 0), (0, sy)))
            glyph.coordinates.translate((left - glyph.xMin * sx, low - glyph.yMin * sy))
            glyph.coordinates.toInt()
        elif name in text:
            # As big as it was (the em grew), centred in the cell, on the baseline.
            grow = em / units
            glyph.coordinates.transform(((grow, 0), (0, grow)))
            glyph.coordinates.translate((width / 2 - (glyph.xMin + glyph.xMax) / 2 * grow, 0))
            glyph.coordinates.toInt()
        else:
            # Centred on the line.
            glyph.coordinates.translate((0, round((ascent + descent - top - bottom) / 2)))
        glyph.recalcBounds(glyf)
        hmtx[name] = (hmtx[name][0], glyph.xMin)

    # Its line as JetBrains Mono's, so that it doesn't make a line taller.
    font['hhea'].ascent, font['hhea'].descent = round(ascent), round(descent)
    os2 = font['OS/2']
    os2.sTypoAscender, os2.sTypoDescender = round(ascent), round(descent)
    os2.usWinAscent, os2.usWinDescent = round(ascent), round(-descent)
    os2.xAvgCharWidth = width
    # Its own name: it isn't Nerd Fonts' font any more.
    version = font['name'].getDebugName(5)
    for nameID, string in {
        1: FAMILY,
        3: f'{FAMILY}; {version}',
        4: FAMILY,
        6: FAMILY.replace(' ', ''),
        16: FAMILY,
    }.items():
        font['name'].removeNames(nameID=nameID)
        font['name'].setName(string, nameID, 3, 1, 0x409)

    # Every icon, without the hinting scaled outlines don't keep.
    options = Options()
    options.hinting = False
    options.name_IDs = ['*']
    codes = sorted(font.getBestCmap())
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=codes)
    subsetter.subset(font)
    font.flavor = 'woff2'
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    font.save(OUTPUT)

    print(f'{OUTPUT.relative_to(ROOT)}: {len(codes)} icons, {OUTPUT.stat().st_size // 1024} KiB')
    print('unicode-range:', unicode_range(codes))


def unicode_range(codes: list[int]) -> str:
    """The code points as CSS has them: each Private Use Area as one range, the rest as they are."""
    ranges: list[tuple[int, int]] = []
    for start, end in PRIVATE:
        inside = [code for code in codes if start <= code <= end]
        if inside:
            ranges.append((inside[0], inside[-1]))
    for code in codes:
        if any(start <= code <= end for start, end in PRIVATE):
            continue
        if ranges and ranges[-1][1] == code - 1 and ranges[-1][0] < 0xE000:
            ranges[-1] = (ranges[-1][0], code)
        else:
            ranges.append((code, code))
    ranges.sort()
    return ', '.join(f'U+{a:X}' if a == b else f'U+{a:X}-{b:X}' for a, b in ranges)


if __name__ == '__main__':
    main(sys.argv[1])
