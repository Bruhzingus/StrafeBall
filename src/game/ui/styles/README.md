# StrafeBall UI theme

`index.css` is the only stylesheet entry point. `index.html` loads it before game JavaScript, including the loading screen. Components do not import styles independently, so loading a menu cannot change cascade order.

## Ownership

| Sheet | Responsibility |
| --- | --- |
| `tokens.css` | Colors, fonts, spacing, radii, control sizes, shadows, motion, safe areas |
| `primitives.css` | Reusable surfaces, buttons, inputs, headings, keycaps |
| `../menus.css` | Room setup, settings, rulebook, network and music controls |
| `../competitive.css` | Gameplay HUD, ability states, notifications, prompts |
| `../scoreboard.css` | Match scoreboard and responsive layouts |
| `../teamRoom.css` | Team selection, readiness, compact room card |
| `surfaces.css` | Shared paper dialogs, match results, course/race overlays |
| `creator.css` | Creator tools, editor states, graphics tuning |
| `loading.css` | First-load presentation |
| `accessibility.css` | Hidden-state invariant, keyboard focus, reduced motion |

The entry point declares cascade layers in order. The original `src/style.css` is confined to the lowest `legacy` layer for existing geometry, animations and state selectors. Current presentation belongs in the sheets above; new CSS must not be added to the legacy file. Normal declarations in a later layer take precedence without escalating selector specificity. Avoid `!important` except visibility/accessibility invariants; important declarations reverse layer priority.

## Visual language

- Use cream paper for decisions and reference: room setup, settings, help and results.
- Use navy surfaces for information over the court: scoreboard, abilities, timers, tools and prompts.
- Use gold for the primary action, active tools and the panel's top edge.
- Use blue/red for team identity, accompanied by names or labels. Use the `*-ink` colors on paper and `*-light` colors on navy.
- Use the display font for short titles and the UI font for names, instructions and controls. Numeric readouts use tabular figures.
- Use `--sb-text-muted` on paper and `--sb-muted` on dark surfaces. Never communicate state with color alone.
- Keep gameplay progress, transforms, dynamic colors for world effects, and visibility under their existing component logic.

## Adding UI

Reuse the primitives or an existing component class; place component-specific layout in the appropriate sheet. If a new sheet is needed, add it to `index.css` in an explicit layer. Do not import it from TypeScript or inject appearance through inline styles.

```html
<section class="sb-surface" aria-labelledby="room-title">
  <h2 id="room-title" class="sb-heading">Team room</h2>
  <label>Player name <input class="sb-input" /></label>
  <button class="sb-button sb-button--primary" type="button">Ready up</button>
</section>
```

Surface primitives deliberately do not set display, positioning or padding. Components own geometry and interaction state. Use `sb-surface--dark` and `sb-button--dark` together for dark tools. Use native `disabled`/`hidden`, visible focus, descriptive labels and a nearby reason when an action is unavailable.

Change palette values in `tokens.css`. Compatibility aliases such as `--paper` and `--menu-cream` point to the same tokens; do not redefine them with new colors in components.

## Review

Start Vite on port 5173, then run:

```sh
node scripts/theme-review.mjs
node scripts/team-room-review.mjs
node scripts/ui-review.mjs
npm run typecheck
```

The reviews instantiate actual UI components with deterministic state, without a WebGL scene. They cover shared-token propagation, dialog bounds, host/guest permissions, ready flow, focus, match transitions, HUD bounds, event contrast and countdown timing. Screenshots and JSON reports go under `tmp/`. A production build also validates the CSS entry point and asset bundling.
