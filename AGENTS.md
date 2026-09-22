# Icon design rules

- Preserve the approved profile boar in `apps/pwa/public/brand/result-icons/boar-v1.png` and the matching pack-v3 icon; do not redesign their silhouettes without user instruction.
- All new outline UI icons use a 24×24 coordinate grid, stroke width 2, rounded caps and joins (Lucide convention: https://lucide.dev/). Scale proportionally with icon size; check actual mobile rendering.
- Existing generated raster masks require optical correction, not a nominal SVG stroke. Use the shared `kb-icon-weight` wrapper and `--kb-icon-outline-step` token outside the masked element. Target visually comparable weight to a 2px/24px outline; do not apply the correction twice or to already-correct SVG icons.
- Keep details open and legible at 24–32px, and use currentColor. User prefers substantial lines and the approved boar profile, not cartoon pigs.
