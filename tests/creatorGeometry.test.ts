import { describe, expect, it, vi } from 'vitest';
import { CreatorGeometry } from '../src/game/practice/creator/CreatorGeometry';
import { validateLayout } from '../src/game/practice/creator/CreatorLayout';

describe('CreatorGeometry labels', () => {
  it('keeps intentionally blank labels blank instead of substituting placeholder text', () => {
    const { layout } = validateLayout({
      objects: [{ type: 'route_arrow', position: [0, 0, 0], metadata: { label: '' } }]
    });
    const geometry = Object.create(CreatorGeometry.prototype) as any;

    expect(geometry['explicitLabel'](layout.objects[0])).toEqual({ text: '', placeholder: false });
  });

  it('skips label meshes when labels are blank or disabled', () => {
    const geometry = Object.create(CreatorGeometry.prototype) as any;
    geometry['signPlane'] = vi.fn(() => {
      throw new Error('signPlane should not be called for hidden labels');
    });
    geometry['perBuild'] = [];

    const { layout } = validateLayout({
      objects: [{ type: 'route_arrow', position: [0, 0, 0], metadata: { label: '' } }]
    });
    const blankLabelObj = layout.objects[0];
    geometry['attachLabel'](blankLabelObj, {} as any, { text: '', placeholder: false }, 1.4);

    const disabledLabelObj = {
      ...blankLabelObj,
      metadata: { ...(blankLabelObj.metadata ?? {}), label: 'Arrow', labelVisible: false }
    };
    geometry['attachLabel'](disabledLabelObj, {} as any, { text: 'Arrow', placeholder: false }, 1.4);

    expect(geometry['signPlane']).not.toHaveBeenCalled();
    expect(geometry['perBuild']).toHaveLength(0);
  });
});
