"""Build RootRay brand assets from the approved artwork boards.

The files in docs/brand/source/ are user-approved canonical artwork.
This script crops and resizes those images; it does not redraw the
mascot, wordmark, app icon, splash, hero, or UI-state art.

Requires Pillow. Usage:
  C:/Users/Abud/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe scripts/build_brand_assets.py
"""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "docs" / "brand" / "source"
BRAND = ROOT / "docs" / "brand"
MEDIA = ROOT / "docs" / "media"
PUBLIC_BRAND = ROOT / "apps" / "desktop" / "public" / "brand"
ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"

WORDMARK_SOURCE = SOURCE / "wordmark-ui-to-source.png"
ICON_SOURCE = SOURCE / "app-icon-master.png"
HERO_SOURCE = SOURCE / "wide-hero-source.png"
SPLASH_SOURCE = SOURCE / "splash-lockup-source.png"
LOCKUP_SOURCE = SOURCE / "lockup-source.png"
BOARD_SOURCE = SOURCE / "brand-board-source.png"

# Crop boxes are in source-image pixels. They select individual approved
# artwork elements from the brand boards, avoiding labels and frame chrome.
CROPS = {
    "wordmark": (700, 350, 1335, 595),
    "mascot": (340, 180, 940, 790),
    "splash_lockup": (390, 290, 875, 940),
    "hero": (0, 0, 1916, 821),
    "board_icon_256": (772, 42, 909, 178),
    "board_icon_128": (923, 64, 1015, 156),
    "board_icon_64": (1028, 87, 1089, 148),
    "board_icon_32": (1100, 99, 1142, 141),
    "board_icon_16": (1152, 110, 1173, 131),
    "empty": (505, 418, 657, 522),
    "success": (948, 431, 1078, 544),
    "error": (1282, 440, 1423, 557),
    "loading_strip": (1210, 246, 1520, 368),
    "small_banner": (1085, 804, 1519, 900),
}


def crop(src: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    return src.crop(box).convert("RGBA")


def flood_alpha(img: Image.Image, tolerance: int = 20) -> Image.Image:
    """Alpha-out near-black background connected to the image border.

    Connected flood fill preserves dark interior features such as the visor
    and icon rounded-square panel, while removing only the surrounding board
    background.
    """

    im = img.convert("RGBA")
    w, h = im.size
    px = im.load()
    seen = bytearray(w * h)
    q: deque[tuple[int, int]] = deque()

    def is_bg(p: tuple[int, int, int, int]) -> bool:
        r, g, b, a = p
        return a > 0 and r <= tolerance and g <= tolerance and b <= tolerance

    def seed(x: int, y: int) -> None:
        i = y * w + x
        if not seen[i] and is_bg(px[x, y]):
            seen[i] = 1
            q.append((x, y))

    for x in range(w):
        seed(x, 0)
        seed(x, h - 1)
    for y in range(h):
        seed(0, y)
        seed(w - 1, y)

    while q:
        x, y = q.popleft()
        r, g, b, _ = px[x, y]
        px[x, y] = (r, g, b, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h:
                i = ny * w + nx
                if not seen[i] and is_bg(px[nx, ny]):
                    seen[i] = 1
                    q.append((nx, ny))
    return im


def alpha_bbox(img: Image.Image, threshold: int = 18) -> tuple[int, int, int, int] | None:
    alpha = img.getchannel("A")
    mask = alpha.point(lambda a: 255 if a > threshold else 0)
    return mask.getbbox()


def trim(img: Image.Image, pad: int = 10, threshold: int = 18) -> Image.Image:
    box = alpha_bbox(img, threshold)
    if box is None:
        return img
    l, t, r, b = box
    return img.crop((max(0, l - pad), max(0, t - pad), min(img.width, r + pad), min(img.height, b + pad)))


def resize_width(img: Image.Image, width: int, resample: int) -> Image.Image:
    if img.width == width:
        return img
    height = round(img.height * width / img.width)
    return img.resize((width, height), resample)


def square_fit(img: Image.Image, size: int, resample: int) -> Image.Image:
    fitted = img.resize((size, size), resample)
    return fitted.convert("RGBA")


def save_png(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print(f"{path.relative_to(ROOT)} {img.size}")


def main() -> None:
    BRAND.mkdir(parents=True, exist_ok=True)
    MEDIA.mkdir(parents=True, exist_ok=True)
    PUBLIC_BRAND.mkdir(parents=True, exist_ok=True)
    ICONS.mkdir(parents=True, exist_ok=True)

    wordmark_src = Image.open(WORDMARK_SOURCE).convert("RGBA")
    icon_src = Image.open(ICON_SOURCE).convert("RGBA")
    hero_src = Image.open(HERO_SOURCE).convert("RGBA")
    splash_src = Image.open(SPLASH_SOURCE).convert("RGBA")
    lockup_src = Image.open(LOCKUP_SOURCE).convert("RGBA")
    board_src = Image.open(BOARD_SOURCE).convert("RGBA")

    # Prominent identity assets.
    lockup = trim(flood_alpha(splash_src, tolerance=12), pad=24)
    mascot = trim(flood_alpha(crop(lockup_src, CROPS["mascot"]), tolerance=10), pad=18)
    wordmark = trim(flood_alpha(crop(wordmark_src, CROPS["wordmark"]), tolerance=14), pad=12)
    hero = crop(hero_src, CROPS["hero"])

    save_png(lockup, BRAND / "rootray-lockup.png")
    save_png(mascot, BRAND / "rootray-mascot.png")
    save_png(wordmark, BRAND / "rootray-wordmark.png")
    save_png(hero, MEDIA / "rootray-hero.png")

    save_png(resize_width(lockup, 320, Image.Resampling.LANCZOS), PUBLIC_BRAND / "lockup.png")
    save_png(resize_width(mascot, 192, Image.Resampling.NEAREST), PUBLIC_BRAND / "mascot.png")
    save_png(resize_width(wordmark, 260, Image.Resampling.NEAREST), PUBLIC_BRAND / "wordmark.png")
    save_png(resize_width(hero, 1280, Image.Resampling.LANCZOS), PUBLIC_BRAND / "hero.png")

    # UI state artwork from the approved brand board.
    for name, width in (("empty", 176), ("success", 132), ("error", 142)):
        asset = trim(flood_alpha(crop(board_src, CROPS[name]), tolerance=13), pad=8)
        save_png(asset, BRAND / f"rootray-{name}.png")
        save_png(resize_width(asset, width, Image.Resampling.NEAREST), PUBLIC_BRAND / f"{name}.png")

    splash = trim(flood_alpha(crop(splash_src, CROPS["splash_lockup"]), tolerance=10), pad=18)
    save_png(splash, BRAND / "rootray-splash.png")
    save_png(resize_width(splash, 260, Image.Resampling.NEAREST), PUBLIC_BRAND / "splash.png")

    loading = trim(flood_alpha(crop(board_src, CROPS["loading_strip"]), tolerance=13), pad=8)
    banner = crop(board_src, CROPS["small_banner"])
    save_png(loading, BRAND / "rootray-loading-strip.png")
    save_png(banner, BRAND / "rootray-small-banner.png")

    # App icons: use the explicit app-icon row in the brand board for Windows
    # frames. The large frames use the board's tighter 256px composition so
    # Start Menu / Recent / taskbar surfaces read as the robot, not a tiny
    # robot floating inside an extra-padded tile. No hand-authored pixel maps
    # and no orange-ring substitute.
    frames: dict[int, Image.Image] = {}
    windows_icon_source = crop(board_src, CROPS["board_icon_256"])
    for size, key in ((16, "board_icon_16"), (24, "board_icon_32"), (32, "board_icon_32"), (64, "board_icon_64"), (128, "board_icon_128")):
        frames[size] = square_fit(crop(board_src, CROPS[key]), size, Image.Resampling.NEAREST)
    frames[48] = square_fit(windows_icon_source, 48, Image.Resampling.NEAREST)
    frames[256] = square_fit(windows_icon_source, 256, Image.Resampling.NEAREST)

    for size in (16, 24, 32, 64, 128, 256):
        save_png(frames[size], BRAND / f"icon-{size}.png")

    frames[256].save(ICONS / "icon.ico", format="ICO", append_images=[frames[s] for s in (16, 24, 32, 48, 64, 128)])
    save_png(frames[32], ICONS / "32x32.png")
    save_png(frames[128], ICONS / "128x128.png")
    save_png(frames[256], ICONS / "128x128@2x.png")
    save_png(square_fit(windows_icon_source, 512, Image.Resampling.NEAREST), ICONS / "icon.png")

    # Header mark is a board-derived small app icon, not a synthetic glyph.
    save_png(frames[32], PUBLIC_BRAND / "mascot-head.png")

    # GitHub social preview uses the supplied wide artwork directly.
    social = hero.resize((1280, 548), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (1280, 640), (3, 6, 9, 255))
    canvas.alpha_composite(social, (0, 46))
    save_png(canvas, BRAND / "rootray-social-preview.png")


if __name__ == "__main__":
    main()
