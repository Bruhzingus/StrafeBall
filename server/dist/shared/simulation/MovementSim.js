"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMovementInternalState = exports.facingFromAngles = void 0;
exports.isSuperThrowWindow = isSuperThrowWindow;
exports.stepMovement = stepMovement;
const constants_1 = require("../constants");
const CollisionMath_1 = require("./CollisionMath");
const AimMath_1 = require("./AimMath");
const PlayerSim_1 = require("./PlayerSim");
var AimMath_2 = require("./AimMath");
Object.defineProperty(exports, "facingFromAngles", { enumerable: true, get: function () { return AimMath_2.facingFromAngles; } });
var PlayerSim_2 = require("./PlayerSim");
Object.defineProperty(exports, "createMovementInternalState", { enumerable: true, get: function () { return PlayerSim_2.createMovementInternalState; } });
const EPS = 0.001;
/** True if the player is inside the backflip "super throw" timing window this tick. */
function isSuperThrowWindow(internal, c = constants_1.GAME_CONSTANTS) {
    return internal.backflipActive
        && internal.backflipTimer >= c.backflip.superWindowStart
        && internal.backflipTimer <= c.backflip.superWindowEnd;
}
/**
 * Authoritative, deterministic player movement for one fixed tick. This is the single source of
 * truth for movement feel: the server runs it to advance state, and the client runs the EXACT
 * same function to predict and to replay unacknowledged inputs during reconciliation. It is a
 * direct port of the offline MovementController (Quake/Source-style accel + friction, bhop,
 * slide, slide-jump, air-strafe, wall-run, wall-jump, backflip, dash) operating on plain data.
 */
function stepMovement(movementIn, internalIn, dashIn, input, prevInput, dt, boxes, catchStanceActive, c = constants_1.GAME_CONSTANTS, movementScale = 1, cooldownRateScale = 1) {
    let vx = movementIn.velocity.x;
    let vy = movementIn.velocity.y;
    let vz = movementIn.velocity.z;
    let px = movementIn.position.x;
    let py = movementIn.position.y;
    let pz = movementIn.position.z;
    let grounded = movementIn.grounded;
    let sliding = movementIn.sliding;
    let wallRunning = movementIn.wallRunning;
    let dashingThisFrame = false;
    // Crouch only takes physical effect on the ground (body height, speed cap). Holding crouch in
    // the air must NOT shrink the hitbox/body height — that perturbs air-strafe momentum — but it
    // still arms the instant slide-on-landing below via slideHeldActive/crouchPressed.
    const crouching = grounded && input.crouchHeld;
    const slideHeldActive = input.slideHeld || input.crouchHeld;
    let slideTimer = internalIn.slideTimer;
    let slideBufferTimer = internalIn.slideBufferTimer ?? 0;
    let jumpGraceTimer = internalIn.jumpGraceTimer;
    let wallRunTimer = internalIn.wallRunTimer;
    let wallReattachCooldown = internalIn.wallReattachCooldown;
    let dashActiveTimer = internalIn.dashActiveTimer;
    let doubleJumpAvailable = internalIn.doubleJumpAvailable;
    let catchBoostTimer = internalIn.catchBoostTimer;
    let groundHeight = internalIn.groundHeight;
    let lastWallNormalX = internalIn.lastWallNormalX;
    let lastWallNormalZ = internalIn.lastWallNormalZ;
    let backflipActive = internalIn.backflipActive;
    let backflipTimer = internalIn.backflipTimer;
    let backflipCooldown = internalIn.backflipCooldown;
    let dash = dashIn;
    const speedScale = Number.isFinite(movementScale) ? Math.max(0.05, movementScale) : 1;
    const cdRateScale = Number.isFinite(cooldownRateScale) ? Math.max(0.05, cooldownRateScale) : 1;
    const wasGrounded = grounded;
    const yaw = input.lookYawRadians;
    const pitch = (0, AimMath_1.clampLookPitch)(input.lookPitchRadians, c);
    const moveX = clampUnit(input.moveX);
    const moveZ = clampUnit(input.moveZ);
    const fwdX = Math.sin(yaw);
    const fwdZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = -Math.sin(yaw);
    let wishX = rightX * moveX + fwdX * moveZ;
    let wishZ = rightZ * moveX + fwdZ * moveZ;
    const wishLen = Math.hypot(wishX, wishZ);
    const hasWish = wishLen > EPS;
    if (hasWish) {
        wishX /= wishLen;
        wishZ /= wishLen;
    }
    else {
        wishX = 0;
        wishZ = 0;
    }
    const airWishX = moveX > EPS ? rightX : moveX < -EPS ? -rightX : 0;
    const airWishZ = moveX > EPS ? rightZ : moveX < -EPS ? -rightZ : 0;
    const hasAirWish = Math.abs(moveX) > EPS;
    if (!wasGrounded && slideHeldActive) {
        slideBufferTimer = c.slide.airBufferSeconds;
    }
    // --- ground state (uses groundHeight resolved last tick) ---
    if (py <= groundHeight + 1e-3) {
        if (!grounded)
            jumpGraceTimer = c.player.bhopGraceSeconds;
        py = groundHeight;
        vy = Math.max(0, vy);
        grounded = true;
        doubleJumpAvailable = true;
        wallRunning = false;
    }
    else {
        grounded = false;
    }
    if (!grounded && slideHeldActive) {
        slideBufferTimer = c.slide.airBufferSeconds;
    }
    else if (slideBufferTimer > 0) {
        slideBufferTimer = Math.max(0, slideBufferTimer - dt);
    }
    // --- timers ---
    dash = (0, PlayerSim_1.advanceDashState)(dash, dt, c, cdRateScale);
    if (backflipCooldown > 0)
        backflipCooldown = Math.max(0, backflipCooldown - dt * cdRateScale);
    if (backflipActive) {
        backflipTimer += dt;
        if (backflipTimer >= c.backflip.durationSeconds) {
            backflipActive = false;
            backflipTimer = 0;
        }
    }
    if (jumpGraceTimer > 0)
        jumpGraceTimer = Math.max(0, jumpGraceTimer - dt);
    if (wallReattachCooldown > 0)
        wallReattachCooldown = Math.max(0, wallReattachCooldown - dt);
    if (catchBoostTimer > 0)
        catchBoostTimer = Math.max(0, catchBoostTimer - dt);
    if (dashActiveTimer > 0)
        dashActiveTimer = Math.max(0, dashActiveTimer - dt);
    if (sliding) {
        slideTimer += dt;
        const speed = Math.hypot(vx, vz);
        const overholdingSlide = slideHeldActive && slideTimer >= c.slide.overholdBrakeDelay;
        const tooSlow = speed < c.slide.minStartSpeed * 0.55;
        const stoppedFromOverhold = overholdingSlide && speed <= c.player.crouchWalkSpeed * speedScale;
        if (stoppedFromOverhold ||
            (!slideHeldActive && (slideTimer > c.slide.maxDuration || (tooSlow && slideTimer >= c.slide.minDuration)))) {
            sliding = false;
        }
    }
    // --- start slide (edge-triggered) ---
    const slidePressed = input.slidePressed;
    const crouchPressed = input.crouchPressed || (input.crouchHeld && !prevInput.crouchHeld);
    const hsBeforeSlide = Math.hypot(vx, vz);
    const bufferedLandingSlide = !wasGrounded && grounded && slideHeldActive && slideBufferTimer > 0;
    const wantsSlide = slidePressed || bufferedLandingSlide || (crouchPressed && hsBeforeSlide > c.player.crouchWalkSpeed);
    const canSlideFromSpeed = slidePressed || bufferedLandingSlide
        ? hsBeforeSlide > EPS || hasWish
        : hsBeforeSlide > c.player.crouchWalkSpeed;
    if (grounded && !sliding && wantsSlide && canSlideFromSpeed) {
        sliding = true;
        slideTimer = 0;
        slideBufferTimer = 0;
        let sdx = wishX;
        let sdz = wishZ;
        if (!hasWish) {
            const len = Math.hypot(vx, vz);
            if (len > EPS) {
                sdx = vx / len;
                sdz = vz / len;
            }
            else {
                sdx = fwdX;
                sdz = fwdZ;
            }
        }
        const minStartSpeed = c.slide.minStartBoostSpeed * speedScale;
        if (hsBeforeSlide < minStartSpeed) {
            vx = sdx * minStartSpeed;
            vz = sdz * minStartSpeed;
        }
    }
    // --- jump / wall-jump / wall-bounce (edge-triggered) ---
    const jumpPressed = input.jumpPressed;
    const wallBounceNormal = !grounded && !wallRunning ? detectWallBounce(px, pz, vx, vz, c) : null;
    if (jumpPressed) {
        if (wallRunning) {
            let awX = lastWallNormalX;
            let awZ = lastWallNormalZ;
            if (awX * awX + awZ * awZ <= EPS) {
                const away = wallJumpAwayDirection(px, pz, yaw, c);
                awX = away.x;
                awZ = away.z;
            }
            vx += awX * c.wall.jumpAwaySpeed * speedScale;
            vz += awZ * c.wall.jumpAwaySpeed * speedScale;
            vy = c.wall.jumpUpSpeed * speedScale;
            wallRunning = false;
            wallRunTimer = 0;
            wallReattachCooldown = c.wall.reattachCooldownSeconds;
        }
        else if (!grounded && wallBounceNormal !== null) {
            // Hit a wall too head-on to wall-run (steeper than runTriggerAngleDegrees): bounce off with
            // the same impulse as a wall-jump, but doesn't require an active wall-run and is free
            // (no stamina/dash cost). Still sets the reattach cooldown to prevent an immediate re-trigger.
            vx += wallBounceNormal.x * c.wall.jumpAwaySpeed * speedScale;
            vz += wallBounceNormal.z * c.wall.jumpAwaySpeed * speedScale;
            vy = c.wall.jumpUpSpeed * speedScale;
            wallReattachCooldown = c.wall.reattachCooldownSeconds;
        }
        else if (grounded || jumpGraceTimer > 0) {
            if (sliding) {
                vx *= c.slide.jumpBonus;
                vz *= c.slide.jumpBonus;
                sliding = false;
            }
            const bhopBonus = jumpGraceTimer > 0 ? c.player.bhopSpeedBonus : 1;
            vx *= bhopBonus;
            vz *= bhopBonus;
            vy = c.player.jumpSpeed;
            grounded = false;
            doubleJumpAvailable = true;
            jumpGraceTimer = 0;
            if (hasWish) {
                vx += wishX * 0.45;
                vz += wishZ * 0.45;
            }
        }
        else if (doubleJumpAvailable) {
            const result = (0, PlayerSim_1.tryUpwardDash)(dash, { x: vx, y: vy, z: vz }, c, speedScale);
            if (result.ok) {
                dash = result.dash;
                vx = result.velocity.x;
                vy = result.velocity.y;
                vz = result.velocity.z;
                doubleJumpAvailable = false;
                dashingThisFrame = true;
                dashActiveTimer = c.dash.activeSeconds;
            }
        }
    }
    // --- dash (edge-triggered) ---
    const dashPressed = input.dashPressed;
    if (dashPressed) {
        const clientDash = sanitizeDashDirection(input.dashDirection);
        const ddx = clientDash ? clientDash.x : hasWish ? wishX : fwdX;
        const ddz = clientDash ? clientDash.z : hasWish ? wishZ : fwdZ;
        const result = (0, PlayerSim_1.tryDash)(dash, { x: vx, y: vy, z: vz }, { x: ddx, y: 0, z: ddz }, c, speedScale);
        if (result.ok) {
            dash = result.dash;
            vx = result.velocity.x;
            vy = result.velocity.y;
            vz = result.velocity.z;
            dashingThisFrame = true;
            dashActiveTimer = c.dash.activeSeconds;
        }
    }
    // --- backflip (edge-triggered) ---
    const backflipPressed = input.backflipPressed;
    if (backflipPressed && !backflipActive && backflipCooldown <= 0) {
        backflipActive = true;
        backflipTimer = 0;
        backflipCooldown = c.backflip.cooldownSeconds;
        vx += -fwdX * c.backflip.backwardImpulse * speedScale;
        vz += -fwdZ * c.backflip.backwardImpulse * speedScale;
        vy += c.backflip.verticalImpulse * speedScale;
        grounded = false;
    }
    // --- wall-run (automatic attach; A/D-while-W vertical control) ---
    // `wallRunClimbing` is true on the ticks the player is wall-running AND steering vertically (holding
    // W plus a strafe key). `wallRunVerticalInput` is the signed climb amount in [-1, 1] for that tick:
    // +1 = steering fully INTO the wall (climb), -1 = fully AWAY (descend). Both gate/scale the vertical
    // control applied in the gravity block. Holding A/D WITHOUT W does nothing (W is the engage key).
    let wallRunClimbing = false;
    let wallRunVerticalInput = 0;
    const bodyHeightForWallRun = currentBodyHeight(crouching, sliding, c);
    const wallRunCeilingY = maxPlayerYForBodyHeight(bodyHeightForWallRun, c) - c.wall.ceilingDetachDistance;
    if (grounded || wallReattachCooldown > 0) {
        wallRunning = false;
        wallRunTimer = 0;
    }
    else if (py >= wallRunCeilingY) {
        // Reached the top of the runnable wall. Detach and nudge the player downward so the head
        // unsticks from the roof instead of pinning fully vertical (and getting stuck in a corner).
        wallRunning = false;
        wallRunTimer = 0;
        wallReattachCooldown = Math.max(wallReattachCooldown, c.wall.reattachCooldownSeconds);
        if (vy > -c.wall.ceilingDetachPushDown)
            vy = -c.wall.ceilingDetachPushDown;
    }
    else {
        const normal = detectWall(px, pz, c);
        const horizSpeed = Math.hypot(vx, vz);
        if (!normal || horizSpeed < c.wall.minEntrySpeed) {
            wallRunning = false;
            wallRunTimer = 0;
        }
        else {
            const intoWall = -(vx * normal.x + vz * normal.z) / horizSpeed;
            const maxInto = Math.sin(c.wall.runTriggerAngleDegrees * CollisionMath_1.DEG2RAD);
            if (intoWall < -0.25 || intoWall > maxInto) {
                wallRunning = false;
                wallRunTimer = 0;
            }
            else {
                if (!wallRunning) {
                    wallRunning = true;
                    wallRunTimer = 0;
                    // Small one-time kick on attach so you start climbing rather than just sliding along.
                    if (vy < c.wall.runStartUpBoost)
                        vy = c.wall.runStartUpBoost;
                }
                lastWallNormalX = normal.x;
                lastWallNormalZ = normal.z;
                wallRunTimer += dt;
                if (wallRunTimer > c.wall.runMaxSeconds) {
                    wallRunning = false;
                    wallRunTimer = 0;
                    wallReattachCooldown = Math.max(wallReattachCooldown, c.wall.reattachCooldownSeconds);
                }
                else if (moveZ > EPS) {
                    // W is the engage key: while holding forward you run STRAIGHT (hold height), and A/D adjust
                    // height. Steering INTO the wall climbs, AWAY descends — side-relative to which wall you're
                    // on / which way you face. input = -(moveX) * (right · normal): with right=(cos yaw, -sin
                    // yaw) and normal pointing into the court, this is +1 when the held strafe key pushes toward
                    // the wall, 0 with no strafe key (straight). A/D WITHOUT W does nothing (this branch is gated
                    // on W).
                    const rxn = rightX * normal.x + rightZ * normal.z;
                    const verticalInput = clampUnit(-moveX * rxn);
                    // Past the gravity-delay threshold, gravity takes over: climbing (steering up) AND holding
                    // height (no strafe) are disabled — only actively steering away (descend) still uses the
                    // eased climb control. Timer resets whenever the run re-engages (see `!wallRunning` above).
                    const pastGravityDelay = wallRunTimer >= c.wall.runGravityDelaySeconds;
                    if (pastGravityDelay && verticalInput >= 0) {
                        wallRunClimbing = false;
                        wallRunVerticalInput = 0;
                    }
                    else {
                        wallRunClimbing = true;
                        wallRunVerticalInput = verticalInput;
                    }
                }
            }
        }
    }
    // --- friction (before accel, Quake order) ---
    if (grounded && !(dashActiveTimer > 0 && !sliding)) {
        const overholdingSlide = sliding && slideHeldActive && slideTimer >= c.slide.overholdBrakeDelay;
        const slideFrictionMultiplier = overholdingSlide ? c.slide.overholdFrictionMultiplier : c.slide.frictionMultiplier;
        const friction = c.player.friction * (sliding ? slideFrictionMultiplier : 1);
        const decay = Math.exp(-friction * dt);
        vx *= decay;
        vz *= decay;
    }
    // --- accelerate toward wish dir ---
    const speedMultiplier = (catchStanceActive ? c.player.catchStanceSpeedMultiplier : 1) + (catchBoostTimer > 0 ? 0.1 : 0);
    if (grounded) {
        const brakingSlide = sliding && slideHeldActive && slideTimer >= c.slide.overholdBrakeDelay;
        const groundWishSpeed = brakingSlide || (crouching && !sliding)
            ? c.player.crouchWalkSpeed * speedScale
            : c.player.maxGroundSpeed * speedMultiplier * speedScale;
        const accelerated = accelerate(vx, vz, wishX, wishZ, hasWish, groundWishSpeed, c.player.groundAcceleration, dt);
        vx = accelerated.vx;
        vz = accelerated.vz;
    }
    else if (!wallRunClimbing) {
        // CS-style air-strafe: A/D are the air-control keys. W/S conserves momentum in air but does
        // not add forward/back acceleration, so speed comes from side input plus mouse steering.
        // Suppressed while wall-run climbing: there A/D are repurposed to VERTICAL height control, so
        // they must not also push you laterally off the wall.
        const accelerated = accelerate(vx, vz, airWishX, airWishZ, hasAirWish, c.player.airStrafeMaxSpeed * speedScale, c.player.airAcceleration, dt);
        vx = accelerated.vx;
        vz = accelerated.vz;
    }
    // --- gravity / wall-run vertical ---
    if (!grounded) {
        if (wallRunClimbing) {
            // A/D-while-W climb: the signed steer-into-wall input sets the target vertical speed (into the
            // wall = climb, away = descend). Ease vy toward it so it reads as a smooth arc, not a snap.
            const targetVy = wallRunVerticalInput * c.wall.runClimbSpeed * speedScale;
            const alpha = 1 - Math.exp(-c.wall.runClimbSmoothing * dt);
            vy += (targetVy - vy) * alpha;
        }
        else if (wallRunning) {
            // Not steering (W released): residual wall gravity peels you off the arc and down the wall.
            // Past the gravity-delay threshold this ramps up to runLateGravityScale so the run can't be
            // sustained forever.
            const lateGravity = wallRunTimer >= c.wall.runGravityDelaySeconds;
            vy -= c.player.gravity * (lateGravity ? c.wall.runLateGravityScale : c.wall.runGravityScale) * dt;
        }
        else {
            const fallScale = vy < 0 ? c.player.fallGravityMultiplier : 1;
            vy -= c.player.gravity * fallScale * dt;
        }
    }
    // --- soft speed limit ---
    {
        if (grounded || wallRunning) {
            const speedSq = vx * vx + vz * vz;
            const limit = c.player.softSpeedLimit * speedScale;
            if (speedSq > limit * limit) {
                const speed = Math.sqrt(speedSq);
                const bleed = (speed - limit) * Math.min(1, c.player.softLimitBleedRate * dt);
                const k = (speed - bleed) / speed;
                vx *= k;
                vz *= k;
            }
        }
    }
    // --- crouch walk hard cap ---
    if (grounded && crouching && !sliding) {
        const speedSq = vx * vx + vz * vz;
        const limit = c.player.crouchWalkSpeed * speedScale;
        if (speedSq > limit * limit) {
            const k = limit / Math.sqrt(speedSq);
            vx *= k;
            vz *= k;
        }
    }
    // --- integrate + bounds ---
    px += vx * dt;
    py += vy * dt;
    pz += vz * dt;
    px = (0, CollisionMath_1.clamp)(px, -c.map.halfWidth + c.player.radius, c.map.halfWidth - c.player.radius);
    pz = (0, CollisionMath_1.clamp)(pz, -c.map.halfLength + c.player.radius, c.map.halfLength - c.player.radius);
    const bodyHeight = currentBodyHeight(crouching, sliding, c);
    const maxPlayerY = maxPlayerYForBodyHeight(bodyHeight, c);
    if (py > maxPlayerY) {
        py = maxPlayerY;
        if (vy > 0)
            vy = 0;
        wallRunning = false;
        wallRunTimer = 0;
        wallReattachCooldown = Math.max(wallReattachCooldown, c.wall.reattachCooldownSeconds);
    }
    // --- resolve static boxes (ground support + wall push-out) ---
    {
        const r = c.player.radius;
        const stepTolerance = c.player.stepHeight;
        let support = 0;
        for (const b of boxes) {
            if (px + r <= b.minX || px - r >= b.maxX)
                continue;
            if (pz + r <= b.minZ || pz - r >= b.maxZ)
                continue;
            if (b.maxY <= py + stepTolerance && b.maxY > support)
                support = b.maxY;
        }
        groundHeight = support;
        for (const b of boxes) {
            if (b.maxY <= support + 1e-3)
                continue;
            const bodyMinY = Math.max(py, support);
            const bodyMaxY = py + bodyHeight;
            if (bodyMaxY <= b.minY || bodyMinY >= b.maxY)
                continue;
            const overlapX = Math.min(px + r, b.maxX) - Math.max(px - r, b.minX);
            const overlapZ = Math.min(pz + r, b.maxZ) - Math.max(pz - r, b.minZ);
            if (overlapX <= 0 || overlapZ <= 0)
                continue;
            if (overlapX < overlapZ) {
                px += px < (b.minX + b.maxX) * 0.5 ? -overlapX : overlapX;
                vx = 0;
            }
            else {
                pz += pz < (b.minZ + b.maxZ) * 0.5 ? -overlapZ : overlapZ;
                vz = 0;
            }
        }
    }
    const speed = Math.hypot(vx, vz);
    const facing = (0, AimMath_1.facingFromAngles)(yaw, pitch);
    return {
        movement: {
            position: { x: px, y: py, z: pz },
            velocity: { x: vx, y: vy, z: vz },
            yawRadians: yaw,
            pitchRadians: pitch,
            facing,
            grounded,
            crouching,
            sliding,
            wallRunning,
            dashingThisFrame,
            speed
        },
        internal: {
            slideTimer,
            slideBufferTimer,
            jumpGraceTimer,
            wallRunTimer,
            wallReattachCooldown,
            dashActiveTimer,
            doubleJumpAvailable,
            catchBoostTimer,
            groundHeight,
            lastWallNormalX,
            lastWallNormalZ,
            backflipActive,
            backflipTimer,
            backflipCooldown
        },
        dash
    };
}
function accelerate(vx, vz, wishX, wishZ, hasWish, wishSpeed, accel, dt) {
    if (wishSpeed <= 0 || !hasWish)
        return { vx, vz };
    const currentSpeed = vx * wishX + vz * wishZ;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0)
        return { vx, vz };
    const accelSpeed = Math.min(accel * wishSpeed * dt, addSpeed);
    return { vx: vx + wishX * accelSpeed, vz: vz + wishZ * accelSpeed };
}
function detectWall(px, pz, c) {
    const margin = 0.9;
    if (c.map.halfWidth - Math.abs(px) < margin)
        return { x: -Math.sign(px), z: 0 };
    if (c.map.halfLength - Math.abs(pz) < margin)
        return { x: 0, z: -Math.sign(pz) };
    return null;
}
/**
 * Returns the wall normal to bounce off of if the player is airborne, near a wall, and moving
 * into it too head-on to wall-run (steeper than runTriggerAngleDegrees) — null otherwise. Mirrors
 * the offline MovementController.tryWallBounce angle math exactly.
 */
function detectWallBounce(px, pz, vx, vz, c) {
    const normal = detectWall(px, pz, c);
    if (!normal)
        return null;
    const horizSpeed = Math.hypot(vx, vz);
    if (horizSpeed < c.wall.minEntrySpeed)
        return null;
    const intoWall = -(vx * normal.x + vz * normal.z) / horizSpeed;
    const maxInto = Math.sin(c.wall.runTriggerAngleDegrees * CollisionMath_1.DEG2RAD);
    if (intoWall <= maxInto)
        return null;
    return normal;
}
function wallJumpAwayDirection(px, pz, yaw, c) {
    if (Math.abs(Math.abs(px) - c.map.halfWidth) < 0.8)
        return { x: -Math.sign(px), z: 0 };
    if (Math.abs(Math.abs(pz) - c.map.halfLength) < 0.8)
        return { x: 0, z: -Math.sign(pz) };
    return { x: -Math.sin(yaw), z: -Math.cos(yaw) };
}
function currentBodyHeight(crouching, sliding, c) {
    if (sliding)
        return c.player.height * c.slide.heightScale;
    return crouching ? c.player.height * c.player.crouchHeightMultiplier : c.player.height;
}
function maxPlayerYForBodyHeight(bodyHeight, c) {
    return Math.max(0, c.map.wallHeight - bodyHeight - c.player.ceilingClearance);
}
function sanitizeDashDirection(direction) {
    if (!direction)
        return null;
    const x = Number.isFinite(direction.x) ? direction.x : 0;
    const z = Number.isFinite(direction.z) ? direction.z : 0;
    const len = Math.hypot(x, z);
    if (len <= EPS)
        return null;
    return { x: x / len, z: z / len };
}
function clampUnit(value) {
    if (!Number.isFinite(value))
        return 0;
    return value < -1 ? -1 : value > 1 ? 1 : value;
}
