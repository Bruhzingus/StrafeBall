import { describe, it, expect } from 'vitest';
import { CreatorHistory } from '../src/game/practice/creator/CreatorHistory';
import { blankCourseLayout, cloneLayout, type CreatorLayout, type CreatorLayoutObject } from '../src/game/practice/creator/CreatorLayout';

function wall(id: string, x: number): CreatorLayoutObject {
  return { id, type: 'long_wall', position: [x, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
}

function withObjects(...objs: CreatorLayoutObject[]): CreatorLayout {
  const layout = blankCourseLayout();
  layout.objects = objs;
  return layout;
}

describe('CreatorHistory — rebaseObject (collab-safe undo)', () => {
  it('folds a remote upsert into the present and every undo snapshot', () => {
    const history = new CreatorHistory(withObjects(wall('A', 0)));
    // Local edit: move A. Present = {A@10}; undo stack has {A@0}.
    history.commit(withObjects(wall('A', 10)));

    // A collaborator adds B. Fold it into all snapshots.
    history.rebaseObject('B', wall('B', 99));

    // Undo my move of A: the restored snapshot must STILL contain the collaborator's B.
    const undone = history.undo();
    expect(undone).not.toBeNull();
    const ids = undone!.objects.map((o) => o.id).sort();
    expect(ids).toEqual(['A', 'B']);
    // A is back at its pre-move position; B survived the undo.
    expect(undone!.objects.find((o) => o.id === 'A')!.position[0]).toBe(0);
    expect(undone!.objects.find((o) => o.id === 'B')!.position[0]).toBe(99);
  });

  it('folds a remote delete into every snapshot so undo cannot resurrect it', () => {
    const history = new CreatorHistory(withObjects(wall('A', 0), wall('B', 5)));
    history.commit(withObjects(wall('A', 10), wall('B', 5))); // local move of A

    history.rebaseObject('B', null); // collaborator deleted B

    const undone = history.undo();
    expect(undone!.objects.map((o) => o.id)).toEqual(['A']); // B gone from the restored snapshot too
  });

  it('snapshots stay independent — rebasing does not alias objects across the stack', () => {
    const history = new CreatorHistory(withObjects(wall('A', 0)));
    history.commit(withObjects(wall('A', 1)));
    history.rebaseObject('B', wall('B', 0));

    // Mutating the redo/undo result must not bleed into other snapshots.
    const undone = history.undo()!;
    undone.objects.find((o) => o.id === 'B')!.position[0] = 123;
    const redone = history.redo()!;
    expect(redone.objects.find((o) => o.id === 'B')!.position[0]).toBe(0);
  });

  it('rebasing an upsert for an existing id replaces it in-place (no duplicate)', () => {
    const history = new CreatorHistory(withObjects(wall('A', 0)));
    history.rebaseObject('A', wall('A', 50));
    // present now has a single A at 50; commit a no-op to read present via undo baseline
    history.commit(cloneLayout(withObjects(wall('A', 50))));
    const undone = history.undo()!;
    expect(undone.objects.filter((o) => o.id === 'A').length).toBe(1);
    expect(undone.objects[0].position[0]).toBe(50);
  });
});
