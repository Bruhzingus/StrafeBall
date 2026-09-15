from pathlib import Path

def edit(p,a,b):
 s=Path(p).read_text(encoding='utf-8'); assert a in s,(p,a); Path(p).write_text(s.replace(a,b),encoding='utf-8')
p='src/game/map/GymArena.ts'
s=Path(p).read_text(encoding='utf-8'); a=s[s.index('    // Bold center stripe'):s.index('\n  /**',s.index('    // Bold center stripe'))]
b='''    const depth = GAME_CONSTANTS.match.neutralZoneHalfDepth;
    for (const sign of [-1, 1]) {
      const line = this.loader.createVisual('line', {
        name: `neutral_edge_${sign}`,
        size: { width: halfW * 2, height: 0.018, depth: 0.16 },
        position: new Vector3(0, lineY, sign * depth)
      });
      line.material = this.courtLineCenterMat;
    }
    const band = MeshBuilder.CreateGround('neutral_zone_band', { width: halfW * 2, height: depth * 2 }, this.scene);
    band.position.y = 0.006; band.isPickable = false;
    const mat = new StandardMaterial('neutral_band_mat', this.scene);
    mat.diffuseColor = new Color3(0.14, 0.65, 0.68); mat.emissiveColor = new Color3(0.015, 0.06, 0.065);
    mat.alpha = 0.16; mat.specularColor = Color3.Black(); band.material = mat;
  }
'''
edit(p,a,b)
if 'import { GAME_CONSTANTS }' not in s: edit(p,"import {", "import {",) # checked import below
edit(p,'const rowZ = 0.62;', 'const rowZ = GAME_CONSTANTS.match.neutralZoneHalfDepth + 0.25;')
edit(p,'const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2];','const coneXs = [-11.2, -8.4, -5.6, -2.8, 0, 2.8, 5.6, 8.4, 11.2].map(x => x / 13 * TUNING.map.halfWidth);')
p='src/game/map/GymVisualRevamp.ts'
edit(p,'for (const z of [-12, -4, 4, 12])', 'for (const z of [-12, -4, 4, 12].map(z => z / 18 * TUNING.map.halfLength))')
