/**
 * Creator Sandbox — bounded undo/redo.
 *
 * Snapshot-based: each COMPLETED editor action (place, delete, move, rotate, scale, duplicate,
 * property edit, import, reset) pushes one deep-cloned layout snapshot. History is bounded so memory
 * stays flat; we never clone per render frame. Undo/redo just swap whole snapshots — simple and
 * reliable for a course-sized layout.
 */

import { CreatorLayout, cloneLayout } from './CreatorLayout';

const MAX_HISTORY = 80;

export class CreatorHistory {
  private undoStack: CreatorLayout[] = [];
  private redoStack: CreatorLayout[] = [];
  /** The snapshot representing the CURRENT committed state (top of "present"). */
  private present: CreatorLayout;

  constructor(initial: CreatorLayout) {
    this.present = cloneLayout(initial);
  }

  /** Record a new committed state (after an action). Clears the redo branch. */
  commit(next: CreatorLayout): void {
    this.undoStack.push(this.present);
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
    this.redoStack = [];
    this.present = cloneLayout(next);
  }

  /** Replace the present snapshot WITHOUT creating a history entry (e.g. after a load/reset baseline). */
  reset(next: CreatorLayout): void {
    this.present = cloneLayout(next);
    this.undoStack = [];
    this.redoStack = [];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Step back one action. Returns the restored snapshot (cloned), or null if nothing to undo. */
  undo(): CreatorLayout | null {
    const prev = this.undoStack.pop();
    if (!prev) return null;
    this.redoStack.push(this.present);
    this.present = prev;
    return cloneLayout(this.present);
  }

  /** Step forward one action. Returns the restored snapshot (cloned), or null if nothing to redo. */
  redo(): CreatorLayout | null {
    const next = this.redoStack.pop();
    if (!next) return null;
    this.undoStack.push(this.present);
    this.present = next;
    return cloneLayout(this.present);
  }
}
