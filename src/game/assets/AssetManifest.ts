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
  metallic?: number;
  roughness?: number;
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
  | 'wallPad'
  | 'line'
  | 'bleacher'
  | 'mat'
  | 'dummy'
  | 'ball'
  | 'superBall'
  | 'scoreboard';

export const ASSET_MANIFEST: Record<AssetKey, ModelAsset> = {
  floor: {
    key: 'floor',
    glb: null,
    // Warm maple hardwood — school gym palette anchor color.
    material: { diffuse: [0.82, 0.58, 0.24], roughness: 0.58 },
    primitive: { kind: 'box', size: { width: 1, height: 0.08, depth: 1 } }
  },
  wall: {
    key: 'wall',
    glb: null,
    // Light cream cinderblock — upper wall above the padding.
    material: { diffuse: [0.89, 0.87, 0.82], roughness: 0.74 },
    primitive: { kind: 'box' }
  },
  wallPad: {
    key: 'wallPad',
    glb: null,
    // School navy — lower 1.5 m gym wall padding, safety color.
    material: { diffuse: [0.12, 0.28, 0.6], roughness: 0.52 },
    primitive: { kind: 'box' }
  },
  line: {
    key: 'line',
    glb: null,
    material: { diffuse: [1.0, 1.0, 0.98], roughness: 0.46 },
    primitive: { kind: 'box', size: { height: 0.016 } }
  },
  bleacher: {
    key: 'bleacher',
    glb: null,
    // Grey aluminum-style bleacher risers.
    material: { diffuse: [0.52, 0.54, 0.54], metallic: 0.08, roughness: 0.5 },
    primitive: { kind: 'box' }
  },
  mat: {
    key: 'mat',
    glb: null,
    // Deep competition blue crash pad with subtle inner glow so it reads as padded cover.
    material: { diffuse: [0.08, 0.18, 0.76], emissive: [0.01, 0.04, 0.14], roughness: 0.5 },
    primitive: { kind: 'box' }
  },
  dummy: {
    key: 'dummy',
    glb: null,
    // Vivid target red with slight self-illumination so the dummies pop at range.
    material: { diffuse: [0.88, 0.2, 0.18], emissive: [0.08, 0.005, 0.005], roughness: 0.36 },
    primitive: { kind: 'capsule', size: { height: 1.8, radius: 0.35 } }
  },
  ball: {
    key: 'ball',
    glb: null,
    // Classic dodgeball red with a subtle glow so balls are easy to track in motion.
    material: { diffuse: [0.96, 0.12, 0.05], emissive: [0.08, 0.005, 0.0], roughness: 0.34 },
    primitive: { kind: 'sphere', size: { segments: 24 } }
  },
  superBall: {
    key: 'superBall',
    glb: null,
    // Intense golden glow — unmistakable as a charged super.
    material: { diffuse: [1.0, 0.88, 0.14], emissive: [0.35, 0.2, 0.02], roughness: 0.26 },
    primitive: { kind: 'sphere', size: { segments: 24 } }
  },
  scoreboard: {
    key: 'scoreboard',
    glb: null,
    // Dark metal backing for the north-wall scoreboard prop.
    material: { diffuse: [0.1, 0.12, 0.16], metallic: 0.35, roughness: 0.42 },
    primitive: { kind: 'box' }
  }
};
