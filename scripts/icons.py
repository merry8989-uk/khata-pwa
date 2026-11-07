"""Generates the PWA icon set. Run: python3 scripts/icons.py

Writes PNGs into src/icons/ (committed, then copied into the build by
scripts/build.mjs) plus favicon.svg.
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "src" / "icons"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"

TOP = (67, 56, 202)  # indigo-700
BOTTOM = (99, 102, 241)  # indigo-500


def gradient(size: int) -> Image.Image:
    image = Image.new("RGB", (size, size), TOP)
    draw = ImageDraw.Draw(image)
    for y in range(size):
        ratio = y / max(1, size - 1)
        colour = tuple(round(TOP[i] + (BOTTOM[i] - TOP[i]) * ratio) for i in range(3))
        draw.line([(0, y), (size, y)], fill=colour)
    return image


def rounded_mask(size: int, radius_ratio: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return mask


def render(size: int, *, maskable: bool = False, radius_ratio: float = 0.22) -> Image.Image:
    base = gradient(size)
    draw = ImageDraw.Draw(base)

    # Rupee glyph, sized inside the maskable safe zone when needed.
    scale = 0.50 if maskable else 0.54
    font = ImageFont.truetype(FONT, int(size * scale))
    glyph = "\u20b9"
    left, top, right, bottom = draw.textbbox((0, 0), glyph, font=font)
    glyph_height = bottom - top
    x = (size - (right - left)) / 2 - left
    centre_y = size * 0.42
    y = centre_y - glyph_height / 2 - top
    draw.text((x, y), glyph, font=font, fill=(255, 255, 255))

    # Two short ledger rules under the glyph.
    bar_width = size * (0.26 if maskable else 0.30)
    bar_height = max(2, int(size * 0.030))
    gap = size * 0.035
    start_y = size * 0.735
    for index, width_factor in enumerate((1.0, 0.62)):
        width = bar_width * width_factor
        left_x = (size - bar_width) / 2
        draw.rounded_rectangle(
            [left_x, start_y + index * (bar_height + gap), left_x + width, start_y + index * (bar_height + gap) + bar_height],
            radius=bar_height / 2,
            fill=(255, 255, 255, 210),
        )

    if maskable:
        return base  # full bleed; Android applies its own mask

    result = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    result.paste(base, (0, 0), rounded_mask(size, radius_ratio))
    return result


FAVICON = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="Khata">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#4338ca"/>
      <stop offset="1" stop-color="#6366f1"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="14" fill="url(#g)"/>
  <text x="32" y="43" font-family="system-ui, 'Segoe UI', Roboto, sans-serif" font-size="34"
        font-weight="700" fill="#ffffff" text-anchor="middle">\u20b9</text>
  <rect x="20" y="47" width="24" height="3" rx="1.5" fill="#ffffff" opacity="0.85"/>
  <rect x="26" y="52" width="12" height="3" rx="1.5" fill="#ffffff" opacity="0.6"/>
</svg>
"""


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    render(192).save(OUT / "icon-192.png")
    render(512).save(OUT / "icon-512.png")
    render(180).save(OUT / "icon-180.png")
    render(512, maskable=True).convert("RGB").save(OUT / "icon-maskable-512.png")
    (OUT / "favicon.svg").write_text(FAVICON, encoding="utf-8")
    for path in sorted(OUT.iterdir()):
        print(f"{path.name}: {path.stat().st_size} bytes")


if __name__ == "__main__":
    main()
