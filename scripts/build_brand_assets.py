"""Build RootRay brand assets from the canonical masters in docs/brand/.

Masters (committed, do not edit in place):
  docs/brand/lockup-src.png     robot + "RootRay / SEE THE SOURCE" square lockup
  docs/brand/icon-src.png       robot on dark rounded square (app icon)
  docs/brand/wordmark-src.png   robot + "RootRay / UI TO SOURCE" on black
  docs/brand/board.jpg          brand-system reference board
  docs/media/rootray-hero.png   wide storytelling art (README hero)

Generated:
  docs/brand/rootray-lockup.png          square logo lockup (trimmed)
  docs/brand/rootray-mascot.png          transparent robot only (trimmed)
  docs/brand/rootray-wordmark.png        transparent wordmark (trimmed)
  docs/brand/rootray-social-preview.png  1280x640 GitHub social preview
  apps/desktop/public/brand/lockup.png      runtime lockup (320px)
  apps/desktop/public/brand/mascot.png      runtime mascot (192px)
  apps/desktop/public/brand/wordmark.png    runtime wordmark (512w)
  apps/desktop/src-tauri/icons/*.png + icon.ico

Pixel-art assets are resampled with NEAREST so they stay crisp.
Requires Pillow. Usage: python scripts/build_brand_assets.py
"""

from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BRAND = ROOT / "docs" / "brand"
MEDIA = ROOT / "docs" / "media"
PUBLIC_BRAND = ROOT / "apps" / "desktop" / "public" / "brand"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

# The lockup art is robot over ~the top 62% and text below; the robot alone
# ends just above the "RootRay" line.
ROBOT_BOTTOM_RATIO = 0.60


def strip_background(img: Image.Image, is_bg) -> Image.Image:
    """Alpha-out the background connected to the image border via flood fill.

    Only background-colored pixels reachable from an edge are cleared, so
    interior pixels that merely share the background color (robot visor,
    letter counters) are preserved.
    """
    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q = deque()

    def try_seed(x: int, y: int) -> None:
        i = y * w + x
        if not seen[i] and is_bg(px[x, y]):
            seen[i] = 1
            q.append((x, y))

    for x in range(w):
        try_seed(x, 0)
        try_seed(x, h - 1)
    for y in range(h):
        try_seed(0, y)
        try_seed(w - 1, y)

    while q:
        x, y = q.popleft()
        px[x, y] = (px[x, y][0], px[x, y][1], px[x, y][2], 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not seen[i] and is_bg(px[nx, ny]):
                    seen[i] = 1
                    q.append((nx, ny))
    return im


def alpha_bbox(im: Image.Image, threshold: int = 60) -> tuple[int, int, int, int] | None:
    """Content bbox using only clearly-opaque pixels (ignores faint halos)."""
    alpha = im.getchannel("A")
    mask = alpha.point(lambda a: 255 if a > threshold else 0)
    return mask.getbbox()


def trim(im: Image.Image, pad_ratio: float = 0.04, threshold: int = 60) -> Image.Image:
    bbox = alpha_bbox(im, threshold)
    if not bbox:
        return im
    pad = int(max(im.size) * pad_ratio)
    l, t, r, b = bbox
    l = max(0, l - pad)
    t = max(0, t - pad)
    r = min(im.width, r + pad)
    b = min(im.height, b + pad)
    return im.crop((l, t, r, b))


def fit_width(im: Image.Image, width: int, resample=Image.NEAREST) -> Image.Image:
    if im.width == width:
        return im
    h = round(im.height * width / im.width)
    return im.resize((width, h), resample)


def draw_simple_mark(size: int) -> Image.Image:
    """The board's "Logo Mark (Simple)": orange ring + center dot + top spark.

    Used at icon sizes where the mascot stops resolving (16/24px). Drawn at
    8x then downsampled NEAREST for crisp pixel edges.
    """
    from PIL import ImageDraw

    s = size * 8
    im = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    orange = (255, 107, 12, 255)
    cx, cy = s // 2, int(s * 0.58)  # ring center sits low to leave room for the spark
    r_out = int(s * 0.34)
    r_in = int(s * 0.18)
    d.ellipse((cx - r_out, cy - r_out, cx + r_out, cy + r_out), fill=orange)
    d.ellipse((cx - r_in, cy - r_in, cx + r_in, cy + r_in), fill=(0, 0, 0, 0))
    r_dot = int(s * 0.08)
    d.ellipse((cx - r_dot, cy - r_dot, cx + r_dot, cy + r_dot), fill=orange)
    spark = int(s * 0.10)
    d.rectangle((cx - spark, int(s * 0.03), cx + spark, int(s * 0.03) + 2 * spark), fill=orange)
    return im.resize((size, size), Image.NEAREST)


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    PUBLIC_BRAND.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    # --- Square lockup + robot-only mascot ---------------------------------
    lockup_src = Image.open(BRAND / "lockup-src.png").convert("RGBA")
    lockup = trim(lockup_src)
    lockup.save(BRAND / "rootray-lockup.png", optimize=True)
    fit_width(lockup, 320, Image.LANCZOS).save(PUBLIC_BRAND / "lockup.png", optimize=True)
    print("lockup:", lockup.size)

    robot_h = int(lockup_src.height * ROBOT_BOTTOM_RATIO)
    robot = trim(lockup_src.crop((0, 0, lockup_src.width, robot_h)))
    robot.save(BRAND / "rootray-mascot.png", optimize=True)
    fit_width(robot, 192).save(PUBLIC_BRAND / "mascot.png", optimize=True)
    print("mascot:", robot.size)

    # --- Wordmark: black -> transparent -------------------------------------
    wm_src = Image.open(BRAND / "wordmark-src.png")
    wm = strip_background(wm_src, lambda p: max(p[:3]) < 22 and p[3] > 0)
    wm = trim(wm, pad_ratio=0.02)
    wm.save(BRAND / "rootray-wordmark.png", optimize=True)
    fit_width(wm, 512).save(PUBLIC_BRAND / "wordmark.png", optimize=True)
    print("wordmark:", wm.size)

    # --- App icons (NEAREST keeps the pixel art crisp) -----------------------
    icon_src = Image.open(BRAND / "icon-src.png").convert("RGBA")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = {s: icon_src.resize((s, s), Image.NEAREST) for s in sizes}
    # The mascot stops resolving below 32px; the brand's simple mark stays
    # legible (see board.jpg "Logo Mark (Simple)").
    frames[16] = draw_simple_mark(16)
    frames[24] = draw_simple_mark(24)
    frames[256].save(
        ICONS / "icon.ico",
        format="ICO",
        append_images=[frames[s] for s in sizes[:-1]],
    )
    for s, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
        frames[s].save(ICONS / name, optimize=True)
    icon_src.resize((512, 512), Image.NEAREST).save(ICONS / "icon.png", optimize=True)
    print("icons: ico", sizes, "+ png 32/128/256/512")

    # --- GitHub social preview 1280x640 -------------------------------------
    hero = Image.open(MEDIA / "rootray-hero.png").convert("RGBA")
    canvas = Image.new("RGBA", (1280, 640), (5, 8, 12, 255))
    art = fit_width(hero, 1180, Image.LANCZOS)
    canvas.paste(art, ((1280 - art.width) // 2, (640 - art.height) // 2), art)
    canvas.save(BRAND / "rootray-social-preview.png", optimize=True)
    print("social preview: 1280x640")


if __name__ == "__main__":
    main()
