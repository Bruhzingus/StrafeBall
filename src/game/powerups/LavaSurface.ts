import { Mesh, MeshBuilder, Scene, ShaderMaterial } from '@babylonjs/core';
import { GAME_CONSTANTS as C } from '../../../shared/constants';
import { getGraphicsQuality } from '../config/graphicsConfig';
import { settings } from '../config/Settings';

const vertexSource = `
precision highp float;
attribute vec3 position;
uniform mat4 world;
uniform mat4 worldViewProjection;
varying vec2 courtPosition;
void main() {
  courtPosition = (world * vec4(position, 1.0)).xz;
  gl_Position = worldViewProjection * vec4(position, 1.0);
}`;

const fragmentSource = `
precision highp float;
varying vec2 courtPosition;
uniform float time;
uniform float detail;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
             mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0)), f.x), f.y);
}
vec2 fracture(vec2 p) {
  vec2 cell = floor(p), local = fract(p);
  float nearest = 8.0, second = 8.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 offset = vec2(float(x), float(y));
      vec2 seed = cell + offset;
      vec2 jitter = vec2(hash(seed), hash(seed + 17.3));
      vec2 delta = offset + 0.15 + jitter * 0.7 - local;
      float distance = dot(delta, delta);
      if (distance < nearest) { second = nearest; nearest = distance; }
      else second = min(second, distance);
    }
  }
  return vec2(sqrt(second) - sqrt(nearest), sqrt(nearest));
}
void main() {
  // Irregular basalt plates separated by molten cracks, anchored in world metres.
  vec2 p = courtPosition * 1.3 + vec2(time * 0.014, -time * 0.009);
  vec2 warp = vec2(noise(p * 1.1 + time * 0.008), noise(p * 1.1 + 31.4));
  vec2 plate = fracture(p + warp * 0.85);
  float grain = noise(p * 13.0);
  float seam = plate.x * (0.8 + grain * 0.4);
  float molten = 1.0 - smoothstep(0.018, 0.075, seam);
  float core = 1.0 - smoothstep(0.0, 0.018, seam);
  vec3 crust = mix(vec3(0.035, 0.028, 0.026), vec3(0.17, 0.105, 0.07), grain);
  crust *= 0.7 + 0.3 * (1.0 - plate.y);
  if (detail > 0.5) crust *= 0.7 + noise(p * 39.0) * 0.6;
  crust += vec3(0.20, 0.032, 0.006) * (1.0 - smoothstep(0.06, 0.14, seam));
  float heat = 0.91 + 0.09 * sin(time * 1.3 + grain * 12.0);
  vec3 glow = mix(vec3(1.0, 0.19, 0.012), vec3(1.0, 0.72, 0.16), core) * heat;
  gl_FragColor = vec4(mix(crust, glow, molten), 1.0);
}`;

/** One flat, opaque draw call: glowing molten seams and dark flowing crust, with no asset requests. */
export class LavaSurface {
  readonly mesh: Mesh;
  private readonly material: ShaderMaterial;

  constructor(scene: Scene) {
    this.mesh = MeshBuilder.CreateGround('lava_sheet', {
      width: C.map.halfWidth * 2,
      height: C.map.halfLength * 2,
      subdivisions: 1
    }, scene);
    this.material = new ShaderMaterial('map_lava', scene, { vertexSource, fragmentSource }, {
      attributes: ['position'],
      uniforms: ['world', 'worldViewProjection', 'time', 'detail']
    });
    this.material.backFaceCulling = false;
    this.mesh.material = this.material;
    this.mesh.isPickable = false;
    this.mesh.setEnabled(false);
  }

  update(level: number, time: number): void {
    this.mesh.setEnabled(level > 0.01);
    this.mesh.position.y = level + 0.01;
    this.material.setFloat('time', settings.reducedEffects ? 0 : time);
    this.material.setFloat('detail', getGraphicsQuality() === 'polished' ? 1 : 0);
  }

  hide(): void { this.mesh.setEnabled(false); }

  dispose(): void {
    this.mesh.dispose();
    this.material.dispose();
  }
}
