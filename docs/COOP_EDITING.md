# Co-op Course Building

Build a movement course **together with friends in real time** — everyone edits the same course at
once, sees each other moving around, and watches each other's changes appear live. Up to **6 people**
per session.

---

## Getting in

1. From the **practice lobby**, hold **E** at the **Movement Course** portal to enter the yard.
2. In the yard, hold **E** at the **Course Creator** portal (the purple one) to open the editor.
3. In the editor's top toolbar, click **⚇ Co-op**.

A panel opens with two choices:

- **Host with This Course** — shares the course you currently have open. A **room code** appears in
  the CO-OP panel (top-left). Copy it and send it to your friends.
- **Join** — type a friend's room code and click **Join**. Your editor loads *their* course and you
  start building on it together.

> Enter a name first — it's shown on your avatar and in the roster.

---

## Building together

**You see each other.** Every collaborator shows up as a labeled avatar — floating where their camera
is while they're building, or as a player figure if they drop into Playtest. The **CO-OP panel**
(top-left) lists everyone in the session; the host is marked with a ★.

**Your edits sync live.** Placing, moving, rotating, scaling, deleting, and changing properties all
appear for everyone the moment you finish the action (release the drag / confirm the value).

**Object locking — the red glow.** When you select or grab an object, it becomes **yours** for as long
as you have it selected. Everyone else sees that object glowing **red** and *cannot* touch it — they
can't select, move, or delete it until you let go (click empty space, or select something else). This
is what keeps two people from fighting over the same piece.

- If you try to grab something that's glowing red, nothing happens and you'll see a brief **"Locked —
  a collaborator is editing that object"** message. Just wait for them to deselect it.

**Undo is safe.** Your **Undo/Redo (Ctrl+Z / Ctrl+Y)** only affects *your own* recent changes — it will
never revert a collaborator's work.

**Playtest is independent.** Hit **F1** to drop into Playtest and test the course on your own whenever
you like. The others keep building, unaffected — and you'll still see each other moving around.

---

## Saving & ownership

The course belongs to the **host**:

- As you all build, it **autosaves into the host's courses** — so the host keeps everything the group
  made.
- When a **joiner** clicks **Leave Co-op**, they're offered a **"save a copy"** — take a personal copy
  of the finished course into their own courses, or decline and return to their own work untouched. A
  joiner's edits are *never* written over their own saved courses.
- If the **host leaves**, the session **ends for everyone** (it was the host's course). Anyone still in
  gets a "session ended" notice.

To keep the result playable afterward, the host just exits the editor and re-enters the yard — the
course reflects everything you built together (no page reload needed).

---

## Good to know

- **You can't switch courses mid-session.** Trying to open/create/delete a different course while co-op
  is live is blocked ("Leave co-op to switch courses") — switching would desync everyone. Leave the
  session first.
- **Room codes are private.** Only people you send the code to can join. There's no public listing.
- **Coordinate out loud.** The red locks stop you clobbering the same object, but the smoothest sessions
  come from splitting the work ("you take the wall-run lanes, I'll do the finish area").
- **Everyone needs the same game version.** Co-op relies on a server room type that older builds don't
  have. If a friend can't connect, make sure you're both on the current version.
- **Leaving:** click **Leave Co-op** in the panel, or just exit the Course Creator. Starting an online
  duel also ends any co-op session.

---

## Troubleshooting

| Problem | What's happening / what to do |
|---|---|
| "Could not join — check the room code" | The code is wrong, the host already left, or you're on an older version. Double-check the code and that the host is still in the session. |
| An object is red and won't move | A collaborator is editing it right now. Wait until they deselect it (it stops glowing red). |
| My friend can't see my change | Edits sync when you *finish* the action — release the drag or confirm the value. A half-finished drag isn't sent yet. |
| "Session is full" | Six people are already in. Someone needs to leave to make room. |
| Everything vanished / "connection lost" | The connection dropped or the host left. You'll be returned to your own course (with a save-a-copy prompt if you were a guest). |
