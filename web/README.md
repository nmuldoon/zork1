# Zork I — Web Edition

Play the original Zork I (Release 119) in a browser, with coloured ASCII art for every room, an auto-drawn map and a live inventory panel.

## Run it

- Open `web/index.html` directly (works from `file://`), or serve the folder: `python3 -m http.server -d web`.
- No build step and no dependencies.

## How it works

| File | Purpose |
|---|---|
| `js/zmachine.js` | Small Z-machine v3 interpreter that runs the original story file unmodified |
| `js/story.js` | `COMPILED/zork1.z3` embedded as base64 (so `file://` works) |
| `js/art.js` | Art engine: per-character colour palettes, scene lookup by room id/name |
| `js/art-surface.js`, `js/art-underground.js` | Scenes for all 110 rooms; mazes and coal mines are generated from each room's real exits |
| `js/map.js` | Map built from the exit properties in the story file (N/E/W/S/diagonals, Up/Down/In/Out) |
| `js/app.js` | UI glue: transcript, status bar, exit buttons, inventory, save/restore |

- `save` / `restore` store a snapshot in `localStorage`.
- Room art is keyed to object ids in this specific story file; regenerate `js/story.js` with `base64 -w0` if you swap story files.
