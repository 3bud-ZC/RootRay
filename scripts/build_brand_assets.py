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
  docs/brand/icon-{16,24,32}.png         small-size robot icon masters
  apps/desktop/public/brand/lockup.png      runtime lockup (320px)
  apps/desktop/public/brand/mascot.png      runtime mascot (192px)
  apps/desktop/public/brand/mascot-head.png 24px head glyph (header)
  apps/desktop/public/brand/wordmark.png    runtime wordmark (512w)
  apps/desktop/src-tauri/icons/*.png + icon.ico

The app icon is the pixel robot at EVERY size: 16/24/32 use the
hand-authored ROBOT_MAPS below, 48+ downscale icon-src.png (NEAREST).
The orange ring/simple mark was rejected as a primary icon — it may only
appear as secondary decoration (ray endpoint, loading motif), never as
the application icon, logo, or avatar.

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


# --- Hand-authored small robot icons ----------------------------------------
# The pixel robot IS the app identity at every size — the ring/simple mark
# was rejected as a primary icon. Downscaling the 1024px mascot below 48px
# dissolves the face, so 16/24/32 are purpose-built pixel maps that keep the
# recognizable features: white rounded head, black face panel, two orange
# vertical eyes, orange ear ring (left), small orange antenna.
#
# Palette keys: '.' transparent · 'k' dark rounded-square bg · 'W' white
# head · 'w' head shade · 'B' black face · 'O' orange · 'o' orange shade.
ICON_PAL = {
    ".": (0, 0, 0, 0),
    "k": (13, 18, 24, 255),
    "W": (233, 238, 244, 255),
    "w": (168, 178, 190, 255),
    "B": (5, 8, 13, 255),
    "O": (255, 115, 0, 255),
    "o": (200, 88, 0, 255),
}

# 16px — silhouette + black face + two orange eyes + antenna only.
ROBOT_16 = [
    "................",
    "..kkkkkkkkkkkk..",
    ".kkkkkkkkkkkkkk.",
    ".kkkkkkOO.kkkkk.",
    ".kkkkkWWWWkkkkk.",
    ".kkkWWWWWWWWkkk.",
    ".kkWWBBBBBBBWWk.",
    ".kkWBBBBBBBBBWk.",
    ".kkWBBOBBBOBBWk.",
    ".kkWBBOBBBOBBWk.",
    ".kkWBBBBBBBBBWk.",
    ".kkWWBBBBBBBWWk.",
    ".kkkWWWWWWWWkkk.",
    ".kkkkkkkkkkkkkk.",
    "..kkkkkkkkkkkk..",
    "................",
]

# 24px — adds the hollow orange ear ring on the left of the head.
ROBOT_24 = [
    "........................",
    "...kkkkkkkkkkkkkkkkkk...",
    "..kkkkkkkkkkkkkkkkkkkk..",
    ".kkkkkkkkkkkkkkkkkkkkkk.",
    ".kkkkkkkkkkkOO.kkkkkkkk.",
    ".kkkkkkkkkkkOO.kkkkkkkk.",
    ".kkkkkkkkWWWWWWWkkkkkkk.",
    ".kkkkkkWWWWWWWWWWkkkkkk.",
    ".kkkkWWBBBBBBBBBBBWWkkk.",
    ".k.OOWBBOOBBBBBOOBBWkkk.",
    ".kO.OWBBOOBBBBBOOBBWkkk.",
    ".kO.OWBBOOBBBBBOOBBWkkk.",
    ".k.OOWBBBBBBBBBBBBWkkkk.",
    ".kkkkWWBBBBBBBBBWWkkkkk.",
    ".kkkkkWWWWWWWWWWkkkkkk.",
    ".kkkkkkWWWWWWWWkkkkkkk.",
    ".kkkkkkkkkkkkkkkkkkkkkk.",
    ".kkkkkkkkkkkkkkkkkkkkkk.",
    ".kkkkkkkkkkkkkkkkkkkkkk.",
    "..kkkkkkkkkkkkkkkkkkkk..",
    "...kkkkkkkkkkkkkkkkkk...",
    "........................",
    "........................",
    "........................",
]

# 32px — ear ring + a small shoulders hint below the head.
ROBOT_32 = [
    "................................",
    "....kkkkkkkkkkkkkkkkkkkkkkkk....",
    "...kkkkkkkkkkkkkkkkkkkkkkkkkk...",
    "..kkkkkkkkkkkkkkkkkkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkOOOkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkOOOkkkkkkkkkkk..",
    "..kkkkkkkkkkWWWWWWWWkkkkkkkkkk..",
    "..kkkkkkkkWWWWWWWWWWWkkkkkkkkk..",
    "..kkkkkkWWBBBBBBBBBBBBWkkkkkkk..",
    "..kkkkkWWBBBBBBBBBBBBBWkkkkkkk..",
    "..kkkkkWBOOOBBBBBBBOOOBWkkkkkk..",
    "..kkkkkWBOOOBBBBBBBOOOBWkkkkkk..",
    ".kOOO.kWBOOOBBBBBBBOOOBWkkkkkk..",
    ".kO.OkWWBBBBBBBBBBBBBWWkkkkkkk..",
    ".kO.OkWWBBBBBBBBBBBBBWWkkkkkkk..",
    ".kOOO.kkWWBBBBBBBBBWWkkkkkkkkk..",
    "..kkkkkkkWWBBBBBBBWWkkkkkkkkkk..",
    "..kkkkkkkkWWWWWWWWWkkkkkkkkkkk..",
    "..kkkkkkkkkWWWWWWWkkkkkkkkkkkk..",
    "..kkkkkkkkkWWkWWWWWkkkkkkkkkkk..",
    "..kkkkkkkkWWWWWWWWWkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkkkkkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkkkkkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkkkkkkkkkkkkkkk..",
    "..kkkkkkkkkkkkkkkkkkkkkkkkkkkk..",
    "...kkkkkkkkkkkkkkkkkkkkkkkkkk...",
    "....kkkkkkkkkkkkkkkkkkkkkkkk....",
    "................................",
    "................................",
    "................................",
    "................................",
    "................................",
]

ROBOT_MAPS = {16: ROBOT_16, 24: ROBOT_24, 32: ROBOT_32}


def render_map(rows: list[str]) -> Image.Image:
    """Render a pixel map to an RGBA image (1 map char = 1 px)."""
    w = max(len(r) for r in rows)
    im = Image.new("RGBA", (w, len(rows)), (0, 0, 0, 0))
    px = im.load()
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            px[x, y] = ICON_PAL[ch]
    return im


def head_glyph(rows: list[str]) -> Image.Image:
    """Same map with the dark bg removed — head-only mark for in-app use.

    Keeps the full map canvas so the glyph renders at an exact 1:1 pixel
    grid in the app header (no aspect surprise from a tight crop).
    """
    im = render_map(rows)
    px = im.load()
    for y in range(im.height):
        for x in range(im.width):
            if px[x, y] == ICON_PAL["k"]:
                px[x, y] = (0, 0, 0, 0)
    return im


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

    # --- App icons: the robot at EVERY size ---------------------------------
    # 16/24/32 = hand-authored pixel maps (ROBOT_MAPS); 48+ = NEAREST
    # downscale of the full icon master. No ring/simple mark anywhere.
    icon_src = Image.open(BRAND / "icon-src.png").convert("RGBA")
    sizes = [16, 24, 32, 48, 64, 128, 256]
    frames = {s: icon_src.resize((s, s), Image.NEAREST) for s in sizes}
    for s, rows in ROBOT_MAPS.items():
        frames[s] = render_map(rows)
        frames[s].save(BRAND / f"icon-{s}.png", optimize=True)  # inspectable master
    frames[256].save(
        ICONS / "icon.ico",
        format="ICO",
        append_images=[frames[s] for s in sizes[:-1]],
    )
    for s, name in ((32, "32x32.png"), (128, "128x128.png"), (256, "128x128@2x.png")):
        frames[s].save(ICONS / name, optimize=True)
    icon_src.resize((512, 512), Image.NEAREST).save(ICONS / "icon.png", optimize=True)
    print("icons: ico", sizes, "+ png 32/128/256/512")

    # Head-only glyph (no dark square) for the compact app header — the head
    # is the recognizable part at 24px; the full body dissolves.
    head_glyph(ROBOT_24).save(PUBLIC_BRAND / "mascot-head.png", optimize=True)
    print("mascot-head: 24px head glyph")

    # --- GitHub social preview 1280x640 -------------------------------------
    hero = Image.open(MEDIA / "rootray-hero.png").convert("RGBA")
    canvas = Image.new("RGBA", (1280, 640), (5, 8, 12, 255))
    art = fit_width(hero, 1180, Image.LANCZOS)
    canvas.paste(art, ((1280 - art.width) // 2, (640 - art.height) // 2), art)
    canvas.save(BRAND / "rootray-social-preview.png", optimize=True)
    print("social preview: 1280x640")


if __name__ == "__main__":
    main()
