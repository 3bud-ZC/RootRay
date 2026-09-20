# RootRay Brand

The supplied user-approved RootRay artwork is canonical. Future brand
work must derive from the committed source artwork in
`docs/brand/source/`; do not redraw, reinterpret, simplify, or replace
the mascot, app icon, wordmark, lockup, hero, or UI-state illustrations.

## Identity

- **Name:** RootRay
- **Primary tagline:** Point at the UI. Reach the source.
- **Short brand line:** SEE THE SOURCE
- **Mascot:** the approved pixel robot with white/cool-gray body, black
  face plate, orange vertical eyes, orange side ring/headphone detail,
  antenna light, orange ray device, and soft orange glow.
- **Core metaphor:** point at a rendered UI element and follow the ray
  back to source code.

## Source Artwork

| File | Canonical role |
|---|---|
| `source/official-app-icon.png` | Official application icon master for Windows/Tauri surfaces |
| `source/brand-board-source.png` | App icon sizes, loading frames, home/empty/success/error/header/toast references |
| `source/wide-hero-source.png` | README hero and GitHub social preview source |
| `source/splash-lockup-source.png` | Splash / loading lockup source |
| `source/lockup-source.png` | Primary mascot + RootRay / SEE THE SOURCE lockup |
| `source/wordmark-ui-to-source.png` | Horizontal RootRay wordmark source |

`scripts/build_brand_assets.py` is the only supported generator. It
crops and resizes these files; it must not contain custom robot pixel
maps or geometric substitutes. The former `source/app-icon-master.png`
is retained only as historical artwork and is not used for application
icon generation.

## Production Assets

| File | Use |
|---|---|
| `rootray-mascot.png` | Mascot-only brand/state art |
| `rootray-wordmark.png` | Approved RootRay wordmark asset |
| `rootray-lockup.png` | Mascot + RootRay + SEE THE SOURCE lockup |
| `rootray-splash.png` | Splash composition source |
| `rootray-empty.png` | Home/empty-state illustration |
| `rootray-success.png` | Ready/success-state illustration |
| `rootray-error.png` | Error-state illustration |
| `rootray-social-preview.png` | GitHub social preview |
| `icon-16.png` through `icon-256.png` | App icon frames derived from approved artwork |

Runtime copies live in `apps/desktop/public/brand/`. Windows icon
outputs live in `apps/desktop/src-tauri/icons/`.

## Color Tokens

Use the centralized CSS tokens in `apps/desktop/src/index.css`:

| Token | Use |
|---|---|
| `--rr-bg` | app background |
| `--rr-surface` | primary panes and panels |
| `--rr-surface-elevated` | raised surfaces |
| `--rr-border` | pane borders |
| `--rr-text` | primary text |
| `--rr-muted` | secondary text |
| `--rr-orange` | RootRay orange accent |
| `--rr-orange-bright` | hover and glow highlight |
| `--rr-orange-glow` | brand glow |
| `--rr-success`, `--rr-error`, `--rr-info` | semantic states |

Orange is an accent and brand signal, not a blanket UI theme.

## Usage Rules

- Use the approved raster wordmark on prominent brand surfaces.
- Use text only where a raster wordmark would harm constrained OS or UI
  usability.
- Use pixel art on brand surfaces: splash, home, major states, header,
  About, README and repository media.
- Keep the workbench professional: Explorer, editor, Inspector, Output,
  toolbars, buttons, splitters, forms and logs should use the restrained
  desktop-tool palette and system typography.
- Scale pixel-art UI assets with nearest-neighbor when they are intended
  to stay crisp. Hero artwork may scale smoothly.
- Preserve clear space around the lockup and wordmark. Do not crop into
  the mascot glow, ray pixels, feet shadow, or wordmark glow.
- Keep dark backgrounds; the approved identity is designed for the dark
  RootRay shell.

## App Icon Rule

The app icon must be the approved robot icon from the supplied board.
Small Windows icon frames must derive from the board's App Icons row or
the high-resolution approved icon master. Do not hand-author 16/24/32px
robot maps. Do not use the orange ring/simple mark as the application
icon, logo, title-bar icon, taskbar icon, Start Menu icon, installer
icon, uninstaller icon, or avatar.

## Scale System

| Context | Asset | Visible size |
|---|---|---|
| Windows app icon | ICO frames and Tauri icon PNGs | 16-256px |
| Splash | `splash.png` or `lockup.png` | 150-260px |
| Home | `empty.png` + real UI text/actions | 150-190px |
| Ready / success | `success.png` | 56-120px |
| Error | `error.png` | 72-140px |
| Preview waiting/loading | `mascot.png` in `BrandLoader` | 56-80px |
| Header | readable `RootRay` text + canonical tagline | compact, no interior icon |
| README hero / social preview | approved wide artwork | full width |

## Typography

Pixel lettering exists inside the approved artwork only. Application UI
uses the system stack; code, paths and logs use the monospace token.
