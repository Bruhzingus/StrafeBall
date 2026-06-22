"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BLEACHER_LAYOUT = exports.MAT_SPECS = exports.MAT_DIMENSIONS = void 0;
exports.aabbFromCenter = aabbFromCenter;
exports.matSpecsForPreset = matSpecsForPreset;
exports.matCollisionBox = matCollisionBox;
exports.matKnockedOverBox = matKnockedOverBox;
exports.createBleacherTierSpecs = createBleacherTierSpecs;
exports.createBleacherPanelSpecs = createBleacherPanelSpecs;
exports.createBleacherCollisionBoxes = createBleacherCollisionBoxes;
exports.createGymCollisionBoxes = createGymCollisionBoxes;
exports.createPlayerCollisionBoxes = createPlayerCollisionBoxes;
exports.createBallCollisionBoxes = createBallCollisionBoxes;
const constants_1 = require("../constants");
function aabbFromCenter(cx, cy, cz, hx, hy, hz, meta = {}) {
    return {
        minX: cx - hx,
        maxX: cx + hx,
        minY: cy - hy,
        maxY: cy + hy,
        minZ: cz - hz,
        maxZ: cz + hz,
        ...meta
    };
}
// Mirrors MAT_DIMENSIONS in the client MatObstacle so server and client agree on mat collision.
exports.MAT_DIMENSIONS = { width: 2.6, height: 1.75, depth: 0.18 };
exports.MAT_SPECS = [
    { id: 'mat_-4.5_-5.5', x: -4.5, y: exports.MAT_DIMENSIONS.height / 2, z: -5.5, yawRadians: 0 },
    { id: 'mat_4.5_-5.5', x: 4.5, y: exports.MAT_DIMENSIONS.height / 2, z: -5.5, yawRadians: 0 },
    { id: 'mat_0_-5.5', x: 0, y: exports.MAT_DIMENSIONS.height / 2, z: -5.5, yawRadians: 0 },
    { id: 'mat_0_5.5', x: 0, y: exports.MAT_DIMENSIONS.height / 2, z: 5.5, yawRadians: 0 },
    { id: 'mat_-4.5_5.5', x: -4.5, y: exports.MAT_DIMENSIONS.height / 2, z: 5.5, yawRadians: 0 },
    { id: 'mat_4.5_5.5', x: 4.5, y: exports.MAT_DIMENSIONS.height / 2, z: 5.5, yawRadians: 0 }
];
/**
 * Deterministic mat layouts per host `matPreset` setting. The 2-mat
 * layout is the point-symmetric diagonal pair (one mat per spawn side, rotationally mirrored through
 * center) so neither team gets more cover — matching the court's 180° rotational symmetry. Any
 * unrecognized preset falls back to the full 4-mat layout. This is the single source of truth the
 * server's authoritative mat state AND both worlds' collision derive from, so visuals + player + ball
 * collision always agree on which mats exist.
 */
const MAT_PRESET_IDS = {
    0: [],
    2: ['mat_-4.5_-5.5', 'mat_4.5_5.5'],
    4: ['mat_-4.5_-5.5', 'mat_4.5_-5.5', 'mat_-4.5_5.5', 'mat_4.5_5.5'],
    6: exports.MAT_SPECS.map((spec) => spec.id)
};
function matSpecsForPreset(matPreset) {
    const ids = MAT_PRESET_IDS[matPreset] ?? MAT_PRESET_IDS[4];
    const idSet = new Set(ids);
    return exports.MAT_SPECS.filter((spec) => idSet.has(spec.id));
}
/** Standing-mat collision AABB for a spec. Quarter-turned mats swap width/depth extents. */
function matCollisionBox(spec) {
    const quarterTurned = Math.abs(Math.round(spec.yawRadians / (Math.PI / 2))) % 2 === 1;
    const halfX = (quarterTurned ? exports.MAT_DIMENSIONS.depth : exports.MAT_DIMENSIONS.width) / 2;
    const halfZ = (quarterTurned ? exports.MAT_DIMENSIONS.width : exports.MAT_DIMENSIONS.depth) / 2;
    return aabbFromCenter(spec.x, spec.y, spec.z, halfX, exports.MAT_DIMENSIONS.height / 2, halfZ, { kind: 'mat', id: spec.id });
}
/**
 * Collision AABB for a mat that has been KNOCKED OVER (lying flat on the floor). The fallen mat is a
 * low flat panel: its long axis (the standing 1.75 m height) now lies along the horizontal knock
 * direction, its 2.6 m broad width runs perpendicular, and its 0.18 m thickness is vertical — so the
 * top sits ~0.18 m off the floor. Matches the client visual in MatObstacle.knockOver (center shifted
 * height/2 along the knock heading). This box is added to BOTH worlds: balls bounce off it (and stay
 * live — a mat is the only floor-level surface that keeps a ball alive), and because its top is well
 * under player.stepHeight the player STEPS ONTO it (a small but noticeable low ledge) instead of being
 * walled off. The returned AABB is an axis-aligned bound of the laid panel — exact for cardinal knock
 * directions, a slightly loose bound for diagonal ones.
 */
function matKnockedOverBox(spec, knockDirection) {
    const halfLong = exports.MAT_DIMENSIONS.height / 2; // standing height, now lying along the knock direction
    const halfBroad = exports.MAT_DIMENSIONS.width / 2; // broad face width, perpendicular to the knock direction
    const halfThick = exports.MAT_DIMENSIONS.depth / 2; // panel thickness, now vertical
    const len = Math.hypot(knockDirection.x, knockDirection.z);
    const dx = len > 1e-4 ? knockDirection.x / len : 0;
    const dz = len > 1e-4 ? knockDirection.z / len : 1;
    const cx = spec.x + dx * halfLong;
    const cz = spec.z + dz * halfLong;
    // AABB half-extents of the rotated rectangle (|dir| along long axis, |perp(dir)| along broad axis).
    const halfX = halfLong * Math.abs(dx) + halfBroad * Math.abs(dz);
    const halfZ = halfLong * Math.abs(dz) + halfBroad * Math.abs(dx);
    return aabbFromCenter(cx, halfThick, cz, halfX, halfThick, halfZ, { kind: 'mat', id: spec.id });
}
/**
 * Mat collision boxes for the current state, shared by the player and ball worlds so they always
 * agree. A standing mat is its upright cover box; a knocked-over mat becomes the low flat panel from
 * matKnockedOverBox when its knock direction is known. If a mat is down but no direction was supplied
 * (legacy callers), it is omitted (the old "fully walkable / pass-through" behavior) rather than
 * guessed at.
 */
function matCollisionBoxesForState(activeMatSpecs, knockedOverMatIds, knockedOverMatDirections) {
    const boxes = [];
    for (const spec of activeMatSpecs) {
        if (knockedOverMatIds?.has(spec.id)) {
            const dir = knockedOverMatDirections?.get(spec.id);
            if (dir)
                boxes.push(matKnockedOverBox(spec, dir));
            continue;
        }
        boxes.push(matCollisionBox(spec));
    }
    return boxes;
}
exports.BLEACHER_LAYOUT = {
    tierCount: 5,
    tierRun: 0.54,
    tierRise: 0.32,
    wallInset: 0.35,
    lengthScale: 1.45,
    backThickness: 0.16,
    backHeight: 2.08,
    sideThickness: 0.18
};
function createBleacherTierSpecs() {
    const halfWidth = constants_1.GAME_CONSTANTS.map.halfWidth;
    const halfLength = constants_1.GAME_CONSTANTS.map.halfLength;
    const length = halfLength * exports.BLEACHER_LAYOUT.lengthScale;
    const totalRun = exports.BLEACHER_LAYOUT.tierCount * exports.BLEACHER_LAYOUT.tierRun;
    const innerEdge = halfWidth - exports.BLEACHER_LAYOUT.wallInset - totalRun;
    const specs = [];
    for (const side of [-1, 1]) {
        for (let step = 0; step < exports.BLEACHER_LAYOUT.tierCount; step += 1) {
            const height = (step + 1) * exports.BLEACHER_LAYOUT.tierRise;
            specs.push({
                side,
                step,
                center: {
                    x: side * (innerEdge + exports.BLEACHER_LAYOUT.tierRun * (step + 0.5)),
                    y: height * 0.5,
                    z: 0
                },
                size: {
                    width: exports.BLEACHER_LAYOUT.tierRun,
                    height,
                    depth: length
                }
            });
        }
    }
    return specs;
}
function createBleacherPanelSpecs() {
    const halfWidth = constants_1.GAME_CONSTANTS.map.halfWidth;
    const halfLength = constants_1.GAME_CONSTANTS.map.halfLength;
    const length = halfLength * exports.BLEACHER_LAYOUT.lengthScale;
    const totalRun = exports.BLEACHER_LAYOUT.tierCount * exports.BLEACHER_LAYOUT.tierRun;
    const innerEdge = halfWidth - exports.BLEACHER_LAYOUT.wallInset - totalRun;
    const centerRun = innerEdge + totalRun * 0.5;
    const panelY = exports.BLEACHER_LAYOUT.backHeight * 0.5;
    const specs = [];
    for (const side of [-1, 1]) {
        specs.push({
            side,
            name: 'back',
            center: {
                x: side * (halfWidth - exports.BLEACHER_LAYOUT.wallInset + exports.BLEACHER_LAYOUT.backThickness * 0.5),
                y: panelY,
                z: 0
            },
            size: {
                width: exports.BLEACHER_LAYOUT.backThickness,
                height: exports.BLEACHER_LAYOUT.backHeight,
                depth: length
            }
        });
        for (const zSign of [-1, 1]) {
            specs.push({
                side,
                name: zSign < 0 ? 'south_side' : 'north_side',
                center: {
                    x: side * centerRun,
                    y: panelY,
                    z: zSign * (length * 0.5 + exports.BLEACHER_LAYOUT.sideThickness * 0.5)
                },
                size: {
                    width: totalRun,
                    height: exports.BLEACHER_LAYOUT.backHeight,
                    depth: exports.BLEACHER_LAYOUT.sideThickness
                }
            });
        }
    }
    return specs;
}
function createBleacherCollisionBoxes() {
    const boxes = [];
    for (const tier of createBleacherTierSpecs()) {
        boxes.push(aabbFromCenter(tier.center.x, tier.center.y, tier.center.z, tier.size.width * 0.5, tier.size.height * 0.5, tier.size.depth * 0.5, { kind: 'bleacher', id: `bleacher_tier_${tier.side}_${tier.step}` }));
    }
    for (const panel of createBleacherPanelSpecs()) {
        boxes.push(aabbFromCenter(panel.center.x, panel.center.y, panel.center.z, panel.size.width * 0.5, panel.size.height * 0.5, panel.size.depth * 0.5, { kind: 'bleacher', id: `bleacher_${panel.name}_${panel.side}` }));
    }
    return boxes;
}
/**
 * The static collision boxes of the gym (bleachers + mats), computed purely from constants so
 * the authoritative server and the client's prediction resolve movement against IDENTICAL
 * geometry. These values replicate GymArena.createBleachers()/createMats() exactly. Outer walls
 * are handled by the bounds clamp, not boxes.
 */
function createGymCollisionBoxes() {
    const boxes = createBleacherCollisionBoxes();
    for (const spec of exports.MAT_SPECS) {
        boxes.push(matCollisionBox(spec));
    }
    return boxes;
}
/**
 * Player collision boxes given the live mat state: bleachers always collide; a standing mat is its
 * upright cover box. A knocked-over mat becomes a low flat panel (matKnockedOverBox) the player steps
 * ONTO — a small but noticeable ledge — instead of being omitted entirely. `knockedOverMatIds` is the
 * set of mats currently down (empty = all standing); `knockedOverMatDirections` supplies each down
 * mat's knock heading so the flat box is placed correctly. A down mat with no supplied direction falls
 * back to the legacy "fully walkable" omission.
 */
function createPlayerCollisionBoxes(knockedOverMatIds, 
/** The mats that currently exist (active preset). Defaults to the full set for offline/legacy use. */
activeMatSpecs = exports.MAT_SPECS, knockedOverMatDirections) {
    return [
        ...createBleacherCollisionBoxes(),
        ...matCollisionBoxesForState(activeMatSpecs, knockedOverMatIds, knockedOverMatDirections)
    ];
}
/**
 * Collision boxes balls bounce off: bleachers + mats. A standing mat is solid cover that blocks
 * dodgeballs; a knocked-over mat becomes the low flat panel from matKnockedOverBox, so balls bounce
 * off a fallen mat too (and stay live — see applyMatBounce). Mirrors createPlayerCollisionBoxes so the
 * player and ball worlds always agree on mat state.
 */
function createBallCollisionBoxes(knockedOverMatIds, 
/** The mats that currently exist (active preset). Defaults to the full set for offline/legacy use. */
activeMatSpecs = exports.MAT_SPECS, knockedOverMatDirections) {
    return [
        ...createBleacherCollisionBoxes(),
        ...matCollisionBoxesForState(activeMatSpecs, knockedOverMatIds, knockedOverMatDirections)
    ];
}
