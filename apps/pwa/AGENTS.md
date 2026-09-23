# Mobile interaction rules

- User requirement: no visual hover effects in the mobile interface, including mobile-width previews operated with a mouse. Do not introduce hover changes to colors, borders, shadows, position, scale, or animation on buttons, links, cards, map markers, or form controls.
- Any desktop-only hover effect must be inside `@media (min-width: 1101px) and (hover: hover) and (pointer: fine)`. Checking pointer/hover capability alone is insufficient.
- Preserve explicit pressed/selected/expanded states and keyboard `:focus-visible` feedback. Do not replace hover with sticky focus styles.
- Apply this rule to new and modified components. Mobile previews must look identical before and during mouse hover.
