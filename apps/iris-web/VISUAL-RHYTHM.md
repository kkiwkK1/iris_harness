# Iris UI rhythm

The plum theme, Corbel / YouYuan font stack, reading width and card-authored
interfaces retain their existing roles. Shared shell controls use the tokens
in `src/theme/tokens.css`; do not introduce local near-equivalents.

| Role | Token / scale |
| --- | --- |
| Spacing | `--iris-space-1/2/3/4/6/8`: 4 / 8 / 12 / 16 / 24 / 32px |
| Supporting text | `--iris-label-size`, `--iris-meta-size`: 12px |
| UI text and list rows | `--iris-ui-size`, `--iris-size-row`: 14px |
| Section heading | `--iris-size-title`: 16px |
| Compact / regular / touch control | `--iris-control-compact/height/touch`: 32 / 36 / 44px |
| Control / field / panel corners | `--iris-radius/field/lg`: 8 / 12 / 16px |
| Immediate feedback / disclosure | `--iris-fast/slip`: 120 / 180ms |

Use 4px inside closely related items, 8px between controls, 12px inside compact
groups, 16px for panel content and 24px between sections. These are roles, not
a blanket replacement of all pixel values. Hairlines, icon geometry, reading
gutters and the sidebar's coordinated fold choreography remain intentional
exceptions. Circular controls keep the pill radius.

Applied to the composer, sidebar lists and search, settings fields and selects,
variable rows and tools, navigation previews and interaction feedback. Body
prose, card iframes and bespoke plugin editors are outside this migration.

For future changes, use the source component rule rather than another override
layer. Preserve keyboard focus and reduced-motion rules; check long Chinese
labels, narrow layouts and variable-tree nesting after changing a shared token.
