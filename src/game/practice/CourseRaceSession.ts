/**
 * Course Race — session controller for private online course races (ghost-relay model).
 *
 * Owns the socket client, the ghost renderer, and the race UI; ArenaScene talks to it through the
 * small hooks interface below. The local player's movement/course logic never routes through here —
 * they keep running the offline stack; this layer only relays poses/run events outward and renders
 * everyone else inward. Strictly offline-path only: duels force-close any live session.
 */

import type { Scene } from '@babylonjs/core';
import type { PlayerController } from '../player/PlayerController';
import type { InputManager } from '../input/InputManager';
import { validateLayout, type CreatorLayout } from './creator/CreatorLayout';
import { formatRunTime } from './creator/CourseRunHud';
import { CourseRaceClient } from '../network/CourseRaceClient';
import { CourseGhosts } from './CourseGhosts';
import { CourseRaceUI } from './CourseRaceUI';
import type { RaceRosterEntry, RaceRunEvent } from '../../../shared/courseRace';

export interface CourseRaceHooks {
  /** True while connected/playing an online duel — racing is unavailable then. */
  isDuelOnline(): boolean;
  /** The host's current yard course, JSON-stringified (handed to joiners by the server). */
  currentCourseJson(): string;
  /** We JOINED someone's race: rebuild the yard around their validated course. */
  onAdoptCourse(layout: CreatorLayout): void;
  /** Session over (leave/closed/drop). `usedRemoteCourse` = we were racing a joined host's map. */
  onSessionEnded(usedRemoteCourse: boolean): void;
  /** Restart-all received (host pressed it, or we did): reset the local run + teleport to start. */
  onRestartRun(): void;
  /** Session-level notice for the main HUD banner (e.g. "Race closed — host left"). */
  notify(title: string, subtitle: string): void;
}

export class CourseRaceSession {
  private readonly client: CourseRaceClient;
  private readonly ghosts: CourseGhosts;
  private readonly ui: CourseRaceUI;

  private active = false;
  private joinedRemoteCourse = false;
  private selfId = '';
  private hostId = '';
  private readonly namesById = new Map<string, string>();

  constructor(
    scene: Scene,
    hudRoot: HTMLElement,
    private readonly input: InputManager,
    private readonly hooks: CourseRaceHooks
  ) {
    this.ghosts = new CourseGhosts(scene);
    this.ui = new CourseRaceUI(hudRoot, {
      onCreate: (name) => void this.create(name),
      onJoin: (code, name) => void this.join(code, name),
      onLeaveRace: () => this.leaveSession('left'),
      onRestartAll: () => this.client.sendRestart(),
      onCloseOverlay: () => this.closeOverlay()
    });
    this.client = new CourseRaceClient({
      onWelcome: (welcome) => {
        this.selfId = welcome.selfId;
        this.hostId = welcome.hostId;
        this.applyRoster(welcome.roster, welcome.hostId);
        if (this.joinedRemoteCourse) {
          // Validate the host's course fully client-side before building anything from it.
          try {
            const { layout } = validateLayout(JSON.parse(welcome.courseJson));
            this.hooks.onAdoptCourse(layout);
          } catch {
            this.hooks.notify('RACE', 'Could not read the host course — leaving');
            this.leaveSession('bad-course');
            return;
          }
        }
        this.active = true;
        this.closeOverlay();
        this.ui.showPanel(this.client.roomId);
        this.hooks.notify('RACE STARTED', `Room code ${this.client.roomId} — share it to invite`);
      },
      onRoster: (message) => this.applyRoster(message.roster, message.hostId),
      onPoses: (message) => {
        for (const pose of message.poses) {
          if (pose.id === this.selfId) continue;
          this.ghosts.setPose(pose.id, this.namesById.get(pose.id) ?? 'Racer', pose);
        }
      },
      onEvent: (message) => {
        if (message.id === this.selfId) return; // own finishes already show in the course HUD
        if (message.event.kind === 'finish' && typeof message.event.timeMs === 'number') {
          this.ui.showEvent(`${message.name} finished ${formatRunTime(message.event.timeMs)}`);
        }
      },
      onRestart: () => {
        this.ui.showEvent('Race restarted — go!');
        this.hooks.onRestartRun();
      },
      onClosed: (closed) => {
        this.hooks.notify('RACE OVER', closed.reason === 'host-left' ? 'The host left the race' : 'The race was closed');
        this.teardown();
      },
      onDisconnected: () => {
        if (!this.active) return;
        this.hooks.notify('RACE', 'Connection to the race was lost');
        this.teardown();
      }
    });
  }

  /** A live session (poses flowing) — not just the overlay being open. */
  isActive(): boolean {
    return this.active;
  }

  /** The session owns the screen/input focus (overlay open) or is live. */
  isBusy(): boolean {
    return this.active || this.ui.isOverlayOpen();
  }

  /** RACE ONLINE sign action: open (or close) the create/join overlay. No-op while racing. */
  toggleOverlay(): void {
    if (this.active) return;
    if (this.hooks.isDuelOnline()) return;
    if (this.ui.isOverlayOpen()) {
      this.closeOverlay();
    } else {
      this.ui.openOverlay();
      // The overlay needs a visible cursor: drop the pointer lock and stop the game re-grabbing it.
      this.input.setLockSuppressed(true);
      document.exitPointerLock?.();
    }
  }

  closeOverlay(): void {
    this.ui.closeOverlay();
    this.input.setLockSuppressed(false);
  }

  /**
   * Per-frame while the yard is active: relay the local pose (throttled inside the client) and
   * smooth the ghosts. Cheap no-op when idle.
   */
  update(dt: number, player: PlayerController): void {
    if (!this.active) return;
    const p = player.root.position;
    this.client.sendPose({ x: p.x, y: p.y, z: p.z, yaw: player.root.rotation.y });
    this.ghosts.update(dt);
  }

  /** Local run events from the course tracker (start/checkpoint/finish/reset), relayed outward. */
  reportRunEvent(event: RaceRunEvent): void {
    if (!this.active) return;
    this.client.sendRunEvent(event);
  }

  /** Explicit local leave (Leave Race button, or leaving the yard mid-race). */
  leaveSession(_reason: 'left' | 'left-yard' | 'bad-course'): void {
    if (!this.active && !this.client.connected) return;
    void this.client.leave();
    this.teardown();
  }

  /** Hard shutdown when a duel takes over (or the scene disposes): drop everything silently. */
  forceClose(): void {
    this.closeOverlay();
    if (this.client.connected) void this.client.leave();
    if (this.active) this.teardown();
  }

  dispose(): void {
    this.forceClose();
    this.ghosts.dispose();
    this.ui.dispose();
  }

  // ---------------------------------------------------------------------------------------------

  private async create(name: string): Promise<void> {
    if (this.hooks.isDuelOnline()) return;
    this.ui.setBusy(true);
    this.ui.setStatus('Creating race…', false);
    this.joinedRemoteCourse = false;
    try {
      await this.client.createRace(name, this.hooks.currentCourseJson());
      // The welcome message flips the session active + shows the panel.
    } catch (err) {
      this.ui.setBusy(false);
      this.ui.setStatus(friendlyError(err, 'Could not create the race.'), true);
    }
  }

  private async join(code: string, name: string): Promise<void> {
    if (this.hooks.isDuelOnline()) return;
    this.ui.setBusy(true);
    this.ui.setStatus('Joining race…', false);
    this.joinedRemoteCourse = true;
    try {
      await this.client.joinRace(code, name);
    } catch (err) {
      this.joinedRemoteCourse = false;
      this.ui.setBusy(false);
      this.ui.setStatus(friendlyError(err, 'Could not join — check the room code.'), true);
    }
  }

  private applyRoster(roster: readonly RaceRosterEntry[], hostId: string): void {
    this.hostId = hostId;
    this.namesById.clear();
    const ids = new Set<string>();
    for (const entry of roster) {
      this.namesById.set(entry.id, entry.name);
      if (entry.id !== this.selfId) ids.add(entry.id);
    }
    this.ghosts.retainOnly(ids);
    this.ui.updateRoster(roster, this.selfId, this.selfId === this.hostId);
  }

  private teardown(): void {
    const usedRemote = this.joinedRemoteCourse;
    this.active = false;
    this.joinedRemoteCourse = false;
    this.selfId = '';
    this.hostId = '';
    this.namesById.clear();
    this.ghosts.clear();
    this.ui.hidePanel();
    this.closeOverlay();
    this.hooks.onSessionEnded(usedRemote);
  }
}

function friendlyError(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : '';
  if (/not found/i.test(message)) return 'No race found with that code.';
  if (/rejected|invalid course|too-large|too-many/i.test(message)) return 'The course was rejected by the server.';
  if (/full/i.test(message)) return 'That race is full.';
  return fallback;
}
