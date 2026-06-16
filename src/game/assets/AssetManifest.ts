// Asset manifest: the single source of truth for how each game object LOOKS.
//
// Gameplay is deliberately decoupled from visuals. Collision/hit logic uses simple proxy
// shapes (AABBs in CollisionWorld, radius checks in Ball/ScoringSystem) and never reads a
// visual mesh's geometry. That means the visuals declared here are freely replaceable:
// today they resolve to greybox primitives; once a `.glb` exists under
// public/assets/models/ for an entry, ModelLoader can swap it in with zero gameplay changes.

export type PrimitiveKind = 'box' | 'sphere' | 'capsule';

export interface PrimitiveSize {
  width?: number;
  height?: number;
  depth?: number;
  diameter?: number;
  radius?: number;
  segments?: number;
}

export interface PrimitiveSpec {
  kind: PrimitiveKind;
  /** Default size; callers may override per-instance (walls/lines have varying dimensions). */
  size?: PrimitiveSize;
}

export interface MaterialSpec {
  diffuse: [number, number, number];
  emissive?: [number, number, number];
}

export interface ModelAsset {
  key: string;
  /**
   * Filename of a future GLB under public/assets/models/. While null, ModelLoader builds the
   * `primitive` placeholder instead. Set this (and drop the file in) to upgrade visuals later.
   */
  glb: string | null;
  material: MaterialSpec;
  primitive: PrimitiveSpec;
}

export type AssetKey =
  | 'floor'
  | 'wall'
  | 'line'
  | 'bleacher'
  | 'mat'
  | 'dummy'
  | 'ball'
  | 'superBall';

export const ASSET_MANIFEST: Record<AssetKey, ModelAsset> = {
  floor: {
    key: 'floor',
    glb: null,
    material: { diffuse: [0.74, 0.55, 0.32] },
    primitive: { kind: 'box', size: { width: 1, height: 0.08, depth: 1 } }
  },
  wall: {
    key: 'wall',
    glb: null,
    material: { diffuse: [0.72, 0.77, 0.84] },
    primitive: { kind: 'box' }
  },
  line: {
    key: 'line',
    glb: null,
    material: { diffuse: [0.95, 0.95, 0.92] },
    primitive: { kind: 'box', size: { height: 0.015 } }
  },
  bleacher: {
    key: 'bleacher',
    glb: null,
    material: { diffuse: [0.36, 0.43, 0.52] },
    primitive: { kind: 'box' }
  },
  mat: {
    key: 'mat',
    glb: null,
    material: { diffuse: [0.1, 0.32, 0.85] },
    primitive: { kind: 'box' }
  },
  dummy: {
    key: 'dummy',
    glb: null,
    material: { diffuse: [0.9, 0.25, 0.25] },
    primitive: { kind: 'capsule', size: { height: 1.8, radius: 0.35 } }
  },
  ball: {
    key: 'ball',
    glb: null,
    material: { diffuse: [0.9, 0.08, 0.06] },
    primitive: { kind: 'sphere', size: { segments: 16 } }
  },
  superBall: {
    key: 'superBall',
    glb: null,
    material: { diffuse: [1.0, 0.85, 0.16], emissive: [0.5, 0.35, 0.05] },
    primitive: { kind: 'sphere', size: { segments: 16 } }
  }
};
