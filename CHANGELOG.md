# Changelog

## 2026-06-17

### Added
- Added 5-minute multiplayer soak diagnostics for server/client rate, latency, buffer, heap, and reconciliation metrics.
- Added an independent snapshot scheduler with tests so visual snapshot sends are not starved by simulation catch-up work.
- Added polished HUD feedback: crosshair states, hit markers, clearer quick-start controls, and hidden-by-default debug HUD.
- Added lightweight first-person hand animation pulses for pickup, catch attempt, catch success, parry, throw release, and recoil.
- Added reusable, low-cost combat feedback effects for throw, catch, parry, hit, and hit-revert events.
- Added main room-flow polish with cleaner create/join UI, friendly connection errors, room-code display, and copy button.
- Added client settings for SFX volume and reduced effects mode.

### Changed
- Capped and cleared multiplayer feedback event queues for throw/catch/parry/hit/revert handling.
- Improved practice wall performance by redrawing DynamicTexture labels only when button state changes.
- Reduced visual picking overhead by making greybox model-loader visuals non-pickable by default.
- Quieted audio unlock logging and cleaned up unlock listeners after the AudioContext starts.

### Fixed
- Fixed snapshot drift/starvation behavior by decoupling snapshot cadence from simulation loop completion.
- Fixed stale visual snapshot queuing risks by dropping overdue scheduler sends instead of building latency.
- Fixed reset/rejoin cleanup paths for network/prediction diagnostics and feedback queues.

### Verified
- `npm run typecheck`
- `npm test`
- `cd server && npm run typecheck`
- `cd server && npm test`
- `npm run build`
