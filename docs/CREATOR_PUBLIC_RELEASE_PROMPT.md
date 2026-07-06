# Creator Sandbox Public Release — Implementation Prompt

This is a ready-to-execute prompt, not an interview doc. The design questions were already asked
and answered directly (see "Locked decisions" below); paste the fenced block into a Claude Code
session to implement, phase by phase. Each phase is meant to be independently shippable — stop
after any phase and the game is in a coherent, playable state.

```text
You are evolving Strafeball's Creator Sandbox from a developer-only, password-gated map editor
into a real player-facing feature: any player can build movement/speedrun courses, manage several
of their own, share them as files, and privately race friends live on them.

Project identity: Strafeball is a browser-based first-person movement dodgeball prototype
(Vite + TypeScript + Babylon.js client, Colyseus server, server-authoritative netcode with client
prediction/reconciliation). Read README.md and docs/MASTER_SPEC_COMPLETE.md if you need broader
context before starting.

Read these before changing anything:
1. src/game/practice/creator/CreatorAccess.ts (the password gate to remove)
2. src/game/practice/creator/CreatorStorage.ts (today's singular working-layout model)
3. src/game/practice/creator/CreatorLayout.ts (schema, module catalog, validation)
4. src/game/practice/creator/CreatorEditor.ts (orchestrator)
5. src/game/practice/creator/CreatorPads.ts (ability pads — currently Creator-Playtest-only)
6. src/game/practice/MovementCourse.ts, MovementCourseConfig.ts, MovementCourseHud.ts,
   MovementCourseStorage.ts (dormant timer/checkpoint/leaderboard system, unused since the
   Movement Sandbox pivot — see the [[movement-course-feature]] history: don't assume these
   still integrate cleanly, but don't discard them either)
7. src/game/practice/MovementSandbox.ts + MovementSandboxLayout.ts (the live outdoor yard that
   currently renders/collides the committed course but has none of the timer/checkpoint layer)
8. src/game/practice/creator/layouts/movementCourseLayout.json (the current single official
   course — an 82-object map)
9. src/game/network/MultiplayerOverlay.ts, MultiplayerClient.ts (private room-code create/join
   UX to imitate for the new session type)
10. server/src/rooms/DuelRoom.ts, shared/roomSettings.ts (room lifecycle pattern to imitate)
11. shared/simulation/MovementSim.ts, shared/simulation/MapGeometry.ts (the authoritative
    movement sim; MapGeometry today assumes the fixed gym — a course-session room needs an
    analogous but custom-geometry-driven collision build)

## Locked decisions (already settled — do not re-litigate these)

- Scope: movement/speedrun courses are the near-term focus. Full combat arenas (playable
  dodgeball courts usable in real matches) are an intentionally separate, larger future phase —
  do not design them now, see "Future direction" below.
- Access: remove the password gate entirely. The editor is open to any player, no login or
  account required.
- Discoverability: keep the existing entry point (hold-E at the practice-lobby sign). Do not
  promote it to a main-menu entry in this pass.
- Editor UX: keep the current power-user editor (gizmos, hotkeys, outliner) as the one
  interface. Add onboarding/help (tooltips, a first-run guide) rather than building a second,
  simplified UI.
- Build limits: leave the current effectively-unlimited object/size caps as they are. Do not
  reintroduce caps in this pass.
- Sharing model: stays file-based (export/import). Do not build a server-side catalog, browsing,
  or discovery UI in this pass.
- Identity: no accounts, no login, for this entire initiative. This may need revisiting later
  when/if a real accounts system exists (a separate, larger roadmap item) — do not build toward
  it now.
- Course engine: revive and adapt the dormant MovementCourse.ts/MovementCourseConfig.ts/
  MovementCourseHud.ts/MovementCourseStorage.ts system rather than designing a fresh one, updated
  to work against the current Creator/Sandbox architecture and against ANY loaded course, not one
  hardcoded course.
- Ability pads (stamina/backflip/speed/bounce, CreatorPads.ts) should work in real played/shared
  courses, not just Creator Playtest.
- The current committed default course keeps privileged status as a featured/starter course every
  player has, alongside whatever they build themselves — it does not become "just another course."
- Difficulty is a simple creator-picked preset tag: Beginner / Intermediate / Advanced / Expert.
- Multi-project: players can create, rename, duplicate, delete, and switch between several of
  their own named course projects. This is not a single working-layout model anymore.
- Exported files carry basic metadata (name, optional description, difficulty tag) plus a
  schema/version marker so old and new exports both import safely.
- Online play, when it arrives (Phase 4), means private, invite-only shared practice/race
  sessions on a custom course — not full combat duels. Reuse the existing private-room-code
  create/join UX pattern from Private Match for this new "Course Session" type.
  - Players in a session see each other and run live together, but pass through each other like
    ghosts — no physical collision between racers.
  - Building stays solo. There is no live collaborative co-editing; only a finished course is
    shared and played together.
  - The host's course data transfers to the server and to joining players automatically —
    joiners do not need to have pre-imported the file themselves.
  - Server-side trust is lightweight sanity checks only (reject NaN/out-of-range/degenerate
    geometry, enforce a basic object-count/complexity ceiling so a malformed file can't crash a
    room) — not a heavy validation/review pipeline. Sessions are private/invite-only, so the risk
    profile is low. Exact thresholds are your engineering judgment call.
  - Basic host controls: the host can restart the run for everyone or close the session,
    mirroring how private duels already behave. Otherwise sessions are symmetric.
  - Time/split comparison between the session's participants (live if it's cheap to add,
    otherwise at minimum a post-run comparison).

## Suggested phases

### Phase 1 — Open access + multi-project foundation
- Remove/neuter the CreatorAccess password gate so any player can enter the Creator Sandbox
  directly. Entry point and offline/local nature stay exactly as they are today.
- Convert CreatorStorage.ts from the singular working-layout model (autosave/quick-save/
  published/committed) to multiple named local projects: create, rename, duplicate, delete,
  switch. Migrate any existing single-layout data into a first project rather than losing it.
- Add name + optional description + difficulty preset as project metadata, editable in the
  editor UI.
- Add lightweight onboarding (tooltips/first-run help) since there's no simplified editor mode.
- Acceptance: any player can open the editor with no password, sees the starter course plus
  their own project list, and can create/rename/duplicate/delete multiple named courses locally
  without losing prior local data.

### Phase 2 — Revive the timed course-play layer, including ability pads
- Adapt MovementCourse.ts / MovementCourseConfig.ts / MovementCourseHud.ts /
  MovementCourseStorage.ts to run against any loaded custom course/project, not one hardcoded
  course.
- Promote start/checkpoint/finish triggers from metadata-only markers (per the current Creator
  schema) into real, functional placeable objects a builder can wire into a working timed run.
- Wire CreatorPads.ts ability pads (stamina/backflip/speed/bounce) into the actual played/shared
  course path, not just Creator Playtest.
- Add a local (per-browser) best-time leaderboard per course, since there's no accounts system.
- Acceptance: a player can place start/checkpoint/finish markers and ability pads in their own
  course, run it with a working timer/HUD and functioning pads, and see local best times —
  including on the featured starter course.

### Phase 3 — Friendly sharing
- Replace the "copy JSON to clipboard, paste into a Claude session" workflow with a real
  player-facing export/import flow (file download/upload, or at minimum a polished copy/paste
  with clear success/error feedback for bad or incompatible data).
- Exported files carry the Phase 1 metadata (name/description/difficulty) plus a schema/version
  marker.
- Import shows the course's metadata before/while loading and lands as a new named project —
  never silently overwrites the importer's existing work.
- Acceptance: a player can export a named, tagged course to a shareable file, hand it to someone
  outside the game (Discord, etc.), and that person imports it and sees its metadata, with no
  server involved.

### Phase 4 — Private shared online practice/race sessions
- New session type, reusing the existing private-room-code create/join UX from Private Match,
  for a "Course Session" rather than a duel.
- Host's course data transfers to the server and to joining players automatically on join.
- Server performs lightweight sanity validation (reject NaN/out-of-range/degenerate geometry,
  enforce a basic complexity ceiling) before building server-side collision for the custom
  geometry — likely generated from the Creator layout via the existing CreatorWorld.ts /
  buildCreatorCollisionBoxes helpers, parallel to what MapGeometry.ts does for the fixed gym.
- Runs a position-only shared movement sim on that geometry — no balls, no combat, no hit/score
  simulation.
- Players see each other and run live together, passing through each other like ghosts.
- Time/split comparison between participants; basic host controls (restart run for everyone,
  close session).
- Acceptance: two players can create/join a private course session on one player's custom
  course (including its checkpoints/pads), run it simultaneously without colliding, see each
  other live, and compare times — and a malformed or adversarial course file cannot crash or
  desync the server.

## Future direction (do not design in this pass)

Combat arenas — full dodgeball courts built with this same tool, played in real matches with
balls/hits/scoring — are an intentionally separate, larger future phase. That would need
server-authoritative combat simulation on untrusted custom geometry and a fairness/balance
review, and deserves its own dedicated prompt/conversation later. Don't build toward it now;
just avoid gratuitously foreclosing it (e.g., prefer generically-reusable layout/validation code
over course-mode-specific code where that's cheap and doesn't cost extra design effort today).

## Hard constraints — do not break

- Do not touch DuelRoom / ServerGameLoop combat/duel netcode paths. The course-session room in
  Phase 4 is new and separate — this is not a modification of the 1v1/2v2 combat path.
- Do not add accounts/auth. Identity stays "no login" for this entire initiative.
- Do not build a public catalog/browse/discovery backend. Sharing stays file-based through
  Phase 3; Phase 4's online sessions are private/invite-only, not public rotation.
- Do not add a second, simplified editor UI. One editor, better onboarding.
- Do not design or build combat arenas in this pass.
- Keep tuning/constants shared between offline and online paths exactly as the existing
  architecture does (see README.md's Architecture Notes) — a course session's movement must
  still run the same shared/simulation/MovementSim.ts, not a fork of it.

## Open engineering judgment calls (yours to make, not further user questions)

- Exact sanity-check thresholds for server-side custom geometry (object count ceiling,
  coordinate bounds, etc.).
- Exact versioning/migration strategy for existing single-project CreatorStorage data moving to
  the multi-project model.
- Whether the Course Session is its own Colyseus room type or a mode flag on a generalized room.
- Whether live split-time comparison in Phase 4 is worth the wire cost versus a simpler
  post-run-only comparison — default to post-run first if live splits add meaningful complexity.
```
