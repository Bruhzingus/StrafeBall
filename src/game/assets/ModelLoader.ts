import { Color3, Mesh, MeshBuilder, PBRMaterial, Scene, TransformNode, Vector3 } from '@babylonjs/core';
import { ASSET_MANIFEST, AssetKey, ModelAsset, PrimitiveSize } from './AssetManifest';

export interface VisualOptions {
  name?: string;
  size?: PrimitiveSize;
  position?: Vector3;
  rotationY?: number;
}

/**
 * The visual layer. Everything that needs a mesh asks the ModelLoader for one by asset key
 * instead of calling MeshBuilder directly, so swapping greybox primitives for real models
 * later is a one-place change. Materials are cached per key and shared across instances.
 *
 * `createVisual` is the synchronous greybox path used today. `loadModel` is the async path
 * that will pull a GLB when an asset declares one; it currently falls back to the primitive
 * whenever `glb` is null (i.e. always, for now).
 */
export class ModelLoader {
  private readonly materials = new Map<string, PBRMaterial>();

  constructor(
    public readonly scene: Scene,
    private readonly manifest: Record<AssetKey, ModelAsset> = ASSET_MANIFEST
  ) {}

  /** Shared material for an asset key, built lazily from the manifest. */
  material(key: AssetKey): PBRMaterial {
    const existing = this.materials.get(key);
    if (existing) return existing;

    const spec = this.manifest[key].material;
    const material = new PBRMaterial(`${key}_material`, this.scene);
    material.albedoColor = new Color3(...spec.diffuse);
    material.metallic = spec.metallic ?? 0;
    material.roughness = spec.roughness ?? 0.56;
    if (spec.emissive) material.emissiveColor = new Color3(...spec.emissive);
    this.materials.set(key, material);
    return material;
  }

  /** Build a greybox primitive visual for an asset key (with optional per-instance overrides). */
  createVisual(key: AssetKey, options: VisualOptions = {}): Mesh {
    const asset = this.manifest[key];
    const name = options.name ?? key;
    const size: PrimitiveSize = { ...asset.primitive.size, ...options.size };

    let mesh: Mesh;
    switch (asset.primitive.kind) {
      case 'box':
        mesh = MeshBuilder.CreateBox(name, { width: size.width ?? 1, height: size.height ?? 1, depth: size.depth ?? 1 }, this.scene);
        break;
      case 'sphere':
        mesh = MeshBuilder.CreateSphere(name, { diameter: size.diameter ?? 1, segments: size.segments ?? 16 }, this.scene);
        break;
      case 'capsule':
        mesh = MeshBuilder.CreateCapsule(name, { height: size.height ?? 1, radius: size.radius ?? 0.5 }, this.scene);
        break;
    }

    mesh.material = this.material(key);
    mesh.isPickable = false;
    this.applyTransform(mesh, options);
    return mesh;
  }

  /**
   * Future visual upgrade path. When an asset declares a `glb`, this loads it from
   * public/assets/models/ and returns its root node; otherwise it returns the primitive so
   * call sites can opt into async loading without branching. The glTF loader is imported
   * lazily so it isn't bundled until a real model is actually requested.
   */
  async loadModel(key: AssetKey, options: VisualOptions = {}): Promise<TransformNode> {
    const asset = this.manifest[key];
    if (!asset.glb) return this.createVisual(key, options);

    await import('@babylonjs/loaders'); // registers the glTF/GLB plugin on demand
    const core = await import('@babylonjs/core');
    const result = await core.SceneLoader.ImportMeshAsync('', '/assets/models/', asset.glb, this.scene);
    const root = (result.meshes[0] as TransformNode | undefined) ?? new TransformNode(options.name ?? key, this.scene);
    this.applyTransform(root, options);
    return root;
  }

  private applyTransform(node: TransformNode, options: VisualOptions): void {
    if (options.position) node.position.copyFrom(options.position);
    if (options.rotationY !== undefined) node.rotation.y = options.rotationY;
  }
}
