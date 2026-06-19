import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial, Texture } from '@babylonjs/core';
import type { ICanvasRenderingContext } from '@babylonjs/core/Engines/ICanvas';
import { TUNING } from '../config/tuning';
import { BLEACHER_LAYOUT } from '../../../shared/simulation/MapGeometry';

interface GuideItem {
  label?: string;
  text: string;
}

interface GuideSection {
  heading: string;
  items: GuideItem[];
}

interface GuidePanelSpec {
  name: string;
  z: number;
  title: string;
  accent: string;
  sections: GuideSection[];
  footer: string;
}

type GuideCanvasContext = ICanvasRenderingContext;
type GuideCanvasContext2D = GuideCanvasContext & Pick<
  CanvasRenderingContext2D,
  'textAlign' | 'textBaseline' | 'arcTo'
>;

const PANEL_COUNT = 3;
const EDGE_PADDING = 1.05;
const PANEL_GAP = 0.45;
const GAP_ABOVE_BLEACHERS = 0.6;
const GAP_BELOW_CEILING = 0.62;
const PANEL_HEIGHT = TUNING.map.wallHeight - (BLEACHER_LAYOUT.backHeight + GAP_ABOVE_BLEACHERS) - GAP_BELOW_CEILING;
const PANEL_Y_CENTER = BLEACHER_LAYOUT.backHeight + GAP_ABOVE_BLEACHERS + PANEL_HEIGHT / 2;
const PANEL_DEPTH = 0.05;
const WALL_X = TUNING.map.halfWidth - PANEL_DEPTH / 2 - 0.04;
const BLEACHER_LENGTH = TUNING.map.halfLength * BLEACHER_LAYOUT.lengthScale;
const USABLE_SPAN = BLEACHER_LENGTH - EDGE_PADDING * 2;
const PANEL_WIDTH = (USABLE_SPAN - PANEL_GAP * (PANEL_COUNT - 1)) / PANEL_COUNT;
const TEXTURE_WIDTH = 2048;
const TEXTURE_HEIGHT = 1365;

const GUIDE_PANELS: readonly GuidePanelSpec[] = [
  {
    name: 'guide_defense',
    z: -(PANEL_WIDTH + PANEL_GAP),
    title: 'How To Play',
    accent: '#5fb0ff',
    sections: [
      {
        heading: 'The Match',
        items: [
          { label: '1v1', text: 'First team to 5 points wins.' },
          { label: '2v2', text: 'Each player has 3 lives. Last team standing wins.' },
          { label: 'GET HIT', text: 'Lose a life (2v2) or give up a point (1v1).' },
          { label: 'OUT', text: 'Eliminated players switch to free-cam and spectate.' }
        ]
      },
      {
        heading: 'Defense',
        items: [
          { label: 'EMPTY CLICK', text: 'Catch with an empty hand. Negates the hit.' },
          { label: 'STAY READY', text: 'Face the ball. Stay close. Do not dash.' },
          { label: 'HOLD 2 BALLS', text: 'Auto-parries live shots back, no click needed.' }
        ]
      },
      {
        heading: 'Practice Room',
        items: [
          { label: 'WEST WALL', text: 'Buttons: balls, bots, resets, difficulty.' },
          { label: 'PORTALS', text: 'Queue 1v1 or 2v2 from the gym.' },
          { text: 'Hit dummies and live through return fire.' }
        ]
      }
    ],
    footer: 'A caught or parried ball never scores. Land clean hits before the other side lands theirs.'
  },
  {
    name: 'guide_ball',
    z: 0,
    title: 'Ball Control',
    accent: '#ffd24d',
    sections: [
      {
        heading: 'Hands',
        items: [
          { label: 'LMB / RMB', text: 'Left hand / right hand.' },
          { label: 'E', text: 'Pick up a loose ball.' },
          { label: 'R', text: 'Drop your held ball.' }
        ]
      },
      {
        heading: 'Throws',
        items: [
          { label: 'HOLD CLICK', text: 'Charge a fast straight throw.' },
          { label: 'TAP + RELEASE', text: 'Quick lob with more arc.' },
          { label: 'CROUCH + THROW', text: 'Curve the ball.' },
          { label: 'F', text: 'Fake or cancel.' }
        ]
      },
      {
        heading: 'Holding 2 Balls',
        items: [
          { text: 'Slows you slightly but arms the auto-parry.' },
          { text: 'Landing a hit refills a dash charge — keep throwing.' }
        ]
      }
    ],
    footer: 'Backflip throw: land, then click the timing bar. Center hit = fastest shot.'
  },
  {
    name: 'guide_movement',
    z: PANEL_WIDTH + PANEL_GAP,
    title: 'Movement',
    accent: '#76b8ff',
    sections: [
      {
        heading: 'Core',
        items: [
          { label: 'W A S D', text: 'Move' },
          { label: 'MOUSE', text: 'Look / aim' },
          { label: 'SPACE', text: 'Jump and bunnyhop' },
          { label: 'L-SHIFT', text: 'Dash with 2 charges' },
          { label: 'CTRL', text: 'Crouch' },
          { label: 'C', text: 'Slide while sprinting' }
        ]
      },
      {
        heading: 'Advanced',
        items: [
          { label: 'WALL-RUN', text: 'Sprint beside a wall to carry speed.' },
          { label: 'A / D', text: 'While wall-running: steer toward the wall to climb, away to descend.' },
          { label: 'WALL-JUMP', text: 'Jump off the wall to redirect.' },
          { label: 'Q', text: 'Backflip to set up the QTE throw.' }
        ]
      }
    ],
    footer: 'A wall-run can only climb for the first 1.5s — after that gravity takes over and only descending still works. Jumping to a new wall resets it.'
  }
] as const;

export class GuideWall {
  private readonly disposables: Array<{ dispose(): void }> = [];
  private readonly meshes: Mesh[] = [];

  constructor(scene: Scene) {
    for (const panel of GUIDE_PANELS) {
      this.makePanel(scene, panel);
    }
  }

  private makePanel(scene: Scene, spec: GuidePanelSpec): void {
    const tex = new DynamicTexture(`${spec.name}_tex`, { width: TEXTURE_WIDTH, height: TEXTURE_HEIGHT }, scene, true);
    tex.hasAlpha = false;
    tex.anisotropicFilteringLevel = 16;
    tex.updateSamplingMode(Texture.TRILINEAR_SAMPLINGMODE);

    const ctx = tex.getContext() as GuideCanvasContext2D;
    drawPanelTexture(ctx, TEXTURE_WIDTH, TEXTURE_HEIGHT, spec);
    tex.update(true);

    const panelMat = new StandardMaterial(`${spec.name}_mat`, scene);
    panelMat.diffuseTexture = tex;
    panelMat.emissiveTexture = tex;
    panelMat.emissiveColor = new Color3(1, 1, 1);
    panelMat.disableLighting = true;
    panelMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(tex, panelMat);

    const backMat = new StandardMaterial(`${spec.name}_back_mat`, scene);
    backMat.diffuseColor = new Color3(0.04, 0.06, 0.1);
    backMat.emissiveColor = new Color3(0.01, 0.02, 0.04);
    backMat.specularColor = new Color3(0, 0, 0);
    this.disposables.push(backMat);

    const back = MeshBuilder.CreateBox(`${spec.name}_back`, {
      width: PANEL_WIDTH + 0.16,
      height: PANEL_HEIGHT + 0.14,
      depth: PANEL_DEPTH
    }, scene);
    back.position.set(WALL_X + 0.03, PANEL_Y_CENTER, spec.z);
    back.rotation.y = Math.PI / 2;
    back.material = backMat;
    back.isPickable = false;
    back.freezeWorldMatrix();
    this.meshes.push(back);
    this.disposables.push(back);

    const panel = MeshBuilder.CreatePlane(spec.name, { width: PANEL_WIDTH, height: PANEL_HEIGHT }, scene);
    panel.position.set(WALL_X - 0.01, PANEL_Y_CENTER, spec.z);
    panel.rotation.y = Math.PI / 2;
    panel.material = panelMat;
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

function drawPanelTexture(
  ctx: GuideCanvasContext2D,
  width: number,
  height: number,
  spec: GuidePanelSpec
): void {
  ctx.clearRect(0, 0, width, height);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#102347');
  background.addColorStop(1, '#09152a');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  const glow = ctx.createRadialGradient(width * 0.28, height * 0.22, 0, width * 0.28, height * 0.22, width * 0.82);
  glow.addColorStop(0, 'rgba(255,255,255,0.06)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(255,255,255,0.035)';
  ctx.lineWidth = 2;
  for (let y = 180; y < height - 120; y += 150) {
    ctx.beginPath();
    ctx.moveTo(56, y);
    ctx.lineTo(width - 56, y);
    ctx.stroke();
  }

  drawRoundedRect(ctx, 18, 18, width - 36, height - 36, 26);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 4;
  ctx.stroke();

  drawRoundedRect(ctx, 40, 34, width - 80, 108, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fill();
  ctx.strokeStyle = `${hexToRgba(spec.accent, 0.7)}`;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = spec.accent;
  ctx.font = '700 74px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.title, width / 2, 88);

  const marginX = 76;
  const labelWidth = 500;
  const gap = 42;
  const bodyX = marginX + labelWidth + gap;
  const bodyWidth = width - bodyX - marginX;
  let y = 202;

  for (const section of spec.sections) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = spec.accent;
    ctx.font = '700 40px Arial';
    ctx.fillText(section.heading.toUpperCase(), marginX, y);

    ctx.strokeStyle = hexToRgba(spec.accent, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(marginX, y + 12);
    ctx.lineTo(width - marginX, y + 12);
    ctx.stroke();
    y += 48;

    for (const item of section.items) {
      y += drawGuideItem(ctx, marginX, y, labelWidth, bodyX, bodyWidth, item, spec.accent);
    }

    y += 18;
  }

  const footerY = height - 196;
  drawRoundedRect(ctx, 54, footerY, width - 108, 112, 24);
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fill();
  ctx.strokeStyle = hexToRgba(spec.accent, 0.5);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#dfe9ff';
  ctx.font = '600 34px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  drawWrappedText(ctx, spec.footer, 88, footerY + 56, width - 176, 40, 2);
}

function drawGuideItem(
  ctx: GuideCanvasContext2D,
  labelX: number,
  y: number,
  labelWidth: number,
  bodyX: number,
  bodyWidth: number,
  item: GuideItem,
  accent: string
): number {
  const labelLines = item.label ? wrapText(ctx, item.label, labelWidth, '700 34px Arial') : [];
  const bodyLines = wrapText(ctx, item.text, bodyWidth, item.label ? '600 34px Arial' : '600 36px Arial');
  const lineHeight = item.label ? 40 : 42;
  const contentLines = Math.max(labelLines.length || 0, bodyLines.length);
  const blockHeight = Math.max(64, contentLines * lineHeight + 16);

  if (item.label) {
    drawRoundedRect(ctx, labelX, y - 26, labelWidth, blockHeight, 18);
    ctx.fillStyle = hexToRgba(accent, 0.17);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(accent, 0.38);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffd74a';
    ctx.font = '700 34px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    drawTextLines(ctx, labelLines, labelX + 24, y - 12, lineHeight);

    ctx.fillStyle = '#eef4ff';
    ctx.font = '600 34px Arial';
    drawTextLines(ctx, bodyLines, bodyX, y - 10, lineHeight);
  } else {
    ctx.fillStyle = hexToRgba(accent, 0.88);
    ctx.beginPath();
    ctx.arc(labelX + 14, y + 12, 7, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#d9e8ff';
    ctx.font = '600 36px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    drawTextLines(ctx, bodyLines, labelX + 34, y - 10, lineHeight);
  }

  return blockHeight + 16;
}

function wrapText(
  ctx: GuideCanvasContext2D,
  text: string,
  maxWidth: number,
  font: string
): string[] {
  ctx.font = font;
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || current === '') {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }

  if (current) lines.push(current);
  return lines;
}

function drawWrappedText(
  ctx: GuideCanvasContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number
): void {
  const lines = wrapText(ctx, text, maxWidth, ctx.font).slice(0, maxLines);
  drawTextLines(ctx, lines, x, y - ((lines.length - 1) * lineHeight) / 2, lineHeight);
}

function drawTextLines(
  ctx: GuideCanvasContext2D,
  lines: readonly string[],
  x: number,
  y: number,
  lineHeight: number
): void {
  for (let i = 0; i < lines.length; i += 1) {
    ctx.fillText(lines[i], x, y + i * lineHeight);
  }
}

function drawRoundedRect(
  ctx: GuideCanvasContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function hexToRgba(hex: string, alpha: number): string {
  const normalized = hex.replace('#', '');
  const value = Number.parseInt(normalized, 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
