import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Vector3 } from '@babylonjs/core';
import { TUNING } from '../config/tuning';

export class GuideWall {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly meshes: Mesh[] = [];

  constructor(scene: Scene) {
    // Guide panels on the player's side (south wall, z = -halfLength)
    const wallZ = -TUNING.map.halfLength + 0.15;
    const sidePanelW = 4.0;

    // Keep the center wall lane open so the south scoreboard stays readable.
    this.makePanel(scene, 'guide_movement', -10.4, wallZ,
      sidePanelW, 3.2, Math.PI, [
        ['MOVEMENT', true],
        ['W A S D', 'Move'],
        ['MOUSE', 'Look / Aim'],
        ['SPACE', 'Jump  (bunnyhop!)'],
        ['L-SHIFT', 'Dash  (2 charges)'],
        ['CTRL', 'Crouch'],
        ['C', 'Slide  (while running)'],
        ['Q', 'Backflip'],
        ['', ''],
        ['Wall-run: sprint parallel to wall', false],
        ['  Press jump to wall-jump', false],
      ]
    );

    this.makePanel(scene, 'guide_throw', -5.4, wallZ,
      sidePanelW, 3.2, Math.PI, [
        ['HANDS & THROWING', true],
        ['LMB', 'Left hand'],
        ['RMB', 'Right hand'],
        ['E', 'Pick up ball'],
        ['R', 'Drop ball'],
        ['Hold LMB/RMB', 'Charge throw'],
        ['Release', 'Throw  (charged = fast+straight)'],
        ['Quick tap', 'Quick throw  (drops, arc)'],
        ['Crouch + throw', 'Curve throw'],
        ['Q backflip', 'Land + click the timing bar to throw'],
        ['  Center = fastest', 'edges = slower, miss = no throw'],
        ['F', 'Cancel / fake throw'],
      ]
    );

    this.makePanel(scene, 'guide_catch', 5.4, wallZ,
      sidePanelW, 3.2, Math.PI, [
        ['CATCH & PARRY', true],
        ['Click empty hand', 'at incoming ball to catch'],
        ['  Face ball inside cone', false],
        ['  Range 8m, no dash', false],
        ['  Can catch 1 bounce', false],
        ['', ''],
        ['PARRY (auto)', true],
        ['Hold 2 balls + face ball', false],
        ['Ball bounces back 1.2x', false],
        ['', ''],
        ['OBJECTIVE', true],
        ['Hit opponent with LIVE balls', false],
        ['Dodge, catch, or parry to survive', false],
      ]
    );

    // (The old west-wall "PRACTICE BUTTONS" text panel was removed — the practice control buttons
    // now carry their own labels directly and span the full wall above the bleachers.)
  }

  private makePanel(
    scene: Scene,
    name: string,
    x: number,
    wallZ: number,
    panelW: number,
    panelH: number,
    rotY: number,
    lines: [string, boolean | string][],
    yBase = 2.2
  ): void {
    const TEX_W = 1024;
    const TEX_H = Math.round(TEX_W * panelH / panelW);

    const tex = new DynamicTexture(`${name}_tex`, { width: TEX_W, height: TEX_H }, scene, false);
    tex.hasAlpha = false;

    // Dark background fill
    tex.drawText('', 0, 0, '1px Arial', '#000', '#08111e', false, false);

    const lineH = Math.round(TEX_H / (lines.length + 1.5));
    let row = 0;
    for (const [left, right] of lines) {
      const y = Math.round(lineH * (row + 1.1));
      if (right === true) {
        // Section header
        tex.drawText(left, null, y, `bold ${Math.round(lineH * 0.72)}px Arial`, '#5599ff', 'transparent', false, false);
      } else if (left === '' && right === '') {
        // blank spacer — skip
      } else if (right === false) {
        // body line (full width)
        tex.drawText(left, 20, y, `${Math.round(lineH * 0.6)}px Arial`, '#aac4e8', 'transparent', false, false);
      } else {
        // key + description
        tex.drawText(left, 20, y, `bold ${Math.round(lineH * 0.62)}px Arial`, '#ffdd44', 'transparent', false, false);
        tex.drawText(right as string, Math.round(TEX_W * 0.36), y, `${Math.round(lineH * 0.6)}px Arial`, '#c0d8f0', 'transparent', false, false);
      }
      row++;
    }
    // Upload with Y inversion so canvas text reads correctly on the guide wall planes.
    tex.update(true);

    const mat = new StandardMaterial(`${name}_mat`, scene);
    mat.diffuseTexture = tex;
    mat.emissiveTexture = tex;
    mat.emissiveColor = new Color3(1, 1, 1);
    mat.disableLighting = true;
    mat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(tex, mat);

    // Backing board
    const backMat = new StandardMaterial(`${name}_back_mat`, scene);
    backMat.diffuseColor = new Color3(0.04, 0.06, 0.10);
    this.disposables.push(backMat);

    const back = MeshBuilder.CreateBox(`${name}_back`, { width: panelW + 0.1, height: panelH + 0.1, depth: 0.05 }, scene);
    back.position.set(x, yBase + panelH / 2 - 0.1, wallZ - 0.03);
    back.rotation.y = rotY;
    back.material = backMat;
    back.isPickable = false;
    back.freezeWorldMatrix();
    this.meshes.push(back);
    this.disposables.push(back);

    const panel = MeshBuilder.CreatePlane(name, { width: panelW, height: panelH }, scene);
    panel.position.set(x, yBase + panelH / 2 - 0.1, wallZ + 0.01);
    panel.rotation.y = rotY;
    panel.material = mat;
    panel.isPickable = false;
    panel.freezeWorldMatrix();
    this.meshes.push(panel);
    this.disposables.push(panel);
  }

  setEnabled(enabled: boolean): void {
    for (const mesh of this.meshes) mesh.setEnabled(enabled);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
