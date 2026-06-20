# Scoreboard decorative tray assets

Optional polish images for the top-center `TeamScoreboard` HUD
(`src/game/ui/TeamScoreboard.ts`). They are rendered as tiny `<img>` slots on
the whiteboard's bottom tray. **They are purely decorative** — each slot has an
`onerror` handler that hides it, so the scoreboard looks complete even if these
files are absent.

Drop the provided transparent-PNG assets here with these exact filenames:

| Filename            | Asset                          |
| ------------------- | ------------------------------ |
| `marker-blue.png`   | small blue dry-erase marker    |
| `marker-red.png`    | small red dry-erase marker     |
| `eraser.png`        | black whiteboard eraser        |

Recommended: transparent background, ~horizontal orientation, trimmed tight.
They are displayed only ~13–16px tall, so file size can be small.

To use different paths, pass overrides to the constructor:

```ts
new TeamScoreboard(parent, {
  blueMarker: '/assets/ui/scoreboard/marker-blue.png',
  redMarker:  '/assets/ui/scoreboard/marker-red.png',
  eraser:     '/assets/ui/scoreboard/eraser.png',
});
```
