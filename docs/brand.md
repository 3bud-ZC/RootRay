# RootRay Brand

Canonical identity reference for contributors. The masters live in this
directory; `scripts/build_brand_assets.py` regenerates every derived
asset from them.

## Identity

- **Name:** RootRay (one word, capital R's)
- **Primary tagline:** Point at the UI. Reach the source.
- **Supporting line:** SEE THE SOURCE
- **Mascot:** the pixel-art robot (white/cool-gray body, orange ray
  device, orange visor LEDs)
- **Core metaphor:** rendered UI → inspection ray → source code

## Assets

| File | Use |
|---|---|
| `icon-src.png` | App icon master — robot on dark rounded square |
| `rootray-lockup.png` | Square lockup: robot + wordmark + SEE THE SOURCE |
| `rootray-mascot.png` | Robot only, transparent — headers, states, toasts |
| `rootray-wordmark.png` | Horizontal robot + RootRay + UI TO SOURCE |
| `rootray-social-preview.png` | 1280×640 GitHub social preview |
| `board.jpg` | The approved brand-system reference board |
| `../media/rootray-hero.png` | Wide storytelling art (README hero) |

Runtime copies used by the app live in `apps/desktop/public/brand/`
(lockup, mascot, wordmark — small, optimized). Regenerate with
`python scripts/build_brand_assets.py` — never edit derived files.

## Palette

Sampled from the artwork — use the CSS tokens in
`apps/desktop/src/index.css`, not hardcoded values.

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d1117` | App background (near-black blue) |
| `--bg-raised` | `#151b23` | Panels, cards |
| `--bg-inset` | `#0a0e13` | Inset surfaces, tracks |
| `--border` | `#29313e` | Blue-gray panel borders |
| `--text` | `#e6edf3` | Primary text |
| `--text-dim` | `#8b98a9` | Muted text |
| `--accent` | `#ff6b0c` | RootRay orange — accent only |
| `--accent-bright` | `#ff8a2a` | Glow, hover |
| `--accent-dim` | `#b3502a` | Borders on accent surfaces |
| `--ok` `--warn` `--bad` `--info` | semantic | Status colors |

Orange is an **accent**, never body text. Status colors stay semantic:
running = green, failed = red, analyzing/starting = info blue,
idle/ready accent or muted — always with a text label.

## Usage rules

- **Brand surfaces:** splash/bootstrap, home, empty states, major
  status states, header mark, About, README/GitHub media.
- **Workbench surfaces stay professional:** Explorer, editor,
  Inspector, Output and browser controls use the plain token palette —
  no mascot art, no pixel styling, no decorative borders.
- **Pixel art scales with nearest-neighbor** (`image-rendering:
  pixelated`). Never let it blur.
- **App icon:** mascot down to 32px; below that use the Simple Mark
  (orange ring + center dot + spark — see `board.jpg`). Never shrink
  the wordmark into an icon.
- **Dark backgrounds only** — the identity is designed for the dark
  shell. Don't put the art on light panels.
- **Clear space:** keep at least ~¼ of the lockup height clear around
  the artwork; the masters already carry padding.
- **Reduced motion:** loading animation collapses to a static frame.
- **Don't:** recolor the mascot, place it inside dense panes, use a
  pixel font for UI/code text, or replace the identity with generic
  developer-tool branding.

## Typography

- UI text: system stack (`Segoe UI`, system-ui)
- Code/paths/logs: `--mono` (Cascadia Code / JetBrains Mono / Consolas)
- Pixel lettering exists **only inside the artwork** (wordmark,
  lockup). No pixel font in the UI itself.
