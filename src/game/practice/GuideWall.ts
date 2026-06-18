import { Color3, DynamicTexture, Mesh, MeshBuilder, Scene, StandardMaterial } from '@babylonjs/core';
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

const GUIDE_PANELS: readonly GuidePanelSpec[] = [
  {
    name: 'guide_defense',
    z: -(PANEL_WIDTH + PANEL_GAP),
    title: 'Defense + Practice',
    accent: '#5fb0ff',
    sections: [
      {
        heading: 'Defense',
        items: [
          { label: 'EMPTY CLICK', text: 'Catch incoming balls with an empty hand.' },
          { label: 'STAY READY', text: 'Face the ball, stay in range, and do not dash.' },
          { label: 'HOLD 2 BALLS', text: 'Auto-parry live shots and send them back faster.' }
        ]
      },
      {
        heading: 'Practice Room',
        items: [
          { label: 'WEST WALL', text: 'Use the buttons for balls, bots, resets, and difficulty.' },
          { label: 'PORTALS', text: 'Queue 1v1 or 2v2 online matches from the practice gym.' },
          { text: 'Practice goal: hit dummies and live through return fire.' }
        ]
      }
    ],
    footer: 'Match goal: score with live hits or wipe the other team.'
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
          { label: 'LMB / RMB', text: 'Use your left and right hands separately.' },
          { label: 'E', text: 'Pick up a loose ball.' },
          { label: 'R', text: 'Drop the ball in your hand.' }
        ]
      },
      {
        heading: 'Throws',
        items: [
          { label: 'HOLD CLICK', text: 'Charge a fast, straight throw.' },
          { label: 'TAP + RELEASE', text: 'Quick lob with more arc.' },
          { label: 'CROUCH + THROW', text: 'Curve the ball.' },
          { label: 'F', text: 'Fake or cancel a charge.' }
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
          { label: 'MOUSE', text: 'Look and aim' },
          { label: 'SPACE', text: 'Jump and bunnyhop' },
          { label: 'L-SHIFT', text: 'Dash with 2 charges' },
          { label: 'CTRL', text: 'Crouch' },
          { label: 'C', text: 'Slide while sprinting' }
        ]
      },
      {
        heading: 'Advanced',
        items: [
          { label: 'WALL-RUN', text: 'Sprint beside a wall to stick and carry speed.' },
          { label: 'WALL-JUMP', text: 'Jump off the wall to redirect momentum.' },
          { label: 'Q', text: 'Backflip to set up the QTE throw.' }
        ]
      }
    ],
    footer: 'Keep momentum up with hops, slides, wall-runs, and quick redirects.'
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
    const texWidth = 1536;
    const texHeight = 1024;
    const tex = new DynamicTexture(`${spec.name}_tex`, { width: texWidth, height: texHeight }, scene, false);
    tex.hasAlpha = false;

    const ctx = tex.getContext();
    drawPanelTexture(ctx, texWidth, texHeight, spec);
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
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  spec: GuidePanelSpec
): void {
  ctx.clearRect(0, 0, width, height);

  const background = ctx.createLinearGradient(0, 0, width, height);
  background.addColorStop(0, '#0a1730');
  background.addColorStop(1, '#07111f');
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  for (let i = -height; i < width; i += 90) {
    ctx.fillRect(i, 0, 2, height);
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
  ctx.font = '700 54px Arial';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(spec.title, width / 2, 88);

  const marginX = 64;
  const labelWidth = 380;
  const gap = 34;
  const bodyX = marginX + labelWidth + gap;
  const bodyWidth = width - bodyX - marginX;
  let y = 190;

  for (const section of spec.sections) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = spec.accent;
    ctx.font = '700 30px Arial';
    ctx.fillText(section.heading.toUpperCase(), marginX, y);

    ctx.strokeStyle = hexToRgba(spec.accent, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(marginX, y + 12);
    ctx.lineTo(width - marginX, y + 12);
    ctx.stroke();
    y += 36;

    for (const item of section.items) {
      y += drawGuideItem(ctx, marginX, y, labelWidth, bodyX, bodyWidth, item, spec.accent);
    }

    y += 18;
  }

  const footerY = height - 170;
  drawRoundedRect(ctx, 48, footerY, width - 96, 92, 22);
  ctx.fillStyle = 'rgba(255,255,255,0.045)';
  ctx.fill();
  ctx.strokeStyle = hexToRgba(spec.accent, 0.5);
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = '#dfe9ff';
  ctx.font = '600 28px Arial';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  drawWrappedText(ctx, spec.footer, 74, footerY + 48, width - 148, 34, 2);
}

function drawGuideItem(
  ctx: CanvasRenderingContext2D,
  labelX: number,
  y: number,
  labelWidth: number,
  bodyX: number,
  bodyWidth: number,
  item: GuideItem,
  accent: string
): number {
  const labelLines = item.label ? wrapText(ctx, item.label, labelWidth, '700 25px Arial') : [];
  const bodyLines = wrapText(ctx, item.text, bodyWidth, item.label ? '500 26px Arial' : '500 28px Arial');
  const lineHeight = item.label ? 30 : 32;
  const contentLines = Math.max(labelLines.length || 0, bodyLines.length);
  const blockHeight = Math.max(48, contentLines * lineHeight + 8);

  if (item.label) {
    drawRoundedRect(ctx, labelX, y - 22, labelWidth, blockHeight, 16);
    ctx.fillStyle = hexToRgba(accent, 0.12);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(accent, 0.32);
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.fillStyle = '#ffd74a';
    ctx.font = '700 25px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    drawTextLines(ctx, labelLines, labelX + 18, y - 10, lineHeight);

    ctx.fillStyle = '#eef4ff';
    ctx.font = '500 26px Arial';
    drawTextLines(ctx, bodyLines, bodyX, y - 8, lineHeight);
  } else {
    ctx.fillStyle = hexToRgba(accent, 0.88);
    ctx.beginPath();
    ctx.arc(labelX + 12, y + 8, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#d9e8ff';
    ctx.font = '500 28px Arial';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    drawTextLines(ctx, bodyLines, labelX + 28, y - 8, lineHeight);
  }

  return blockHeight + 10;
}

function wrapText(
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
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
  ctx: CanvasRenderingContext2D,
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
