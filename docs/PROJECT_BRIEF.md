# Strafeball Project Brief

## One-sentence pitch

**Strafeball is a ranked first-person movement dodgeball game where players chain slides, bhops, wall jumps, air strafes, dashes, and backflip throws while using precise aim-tracking catches and hand-based ball control to win high-speed gym-class duels.**

## Core identity

This is not a normal shooter. M1 and M2 are the player's actual hands.

- M1 = left hand
- M2 = right hand
- Empty hand can catch
- Held ball can throw or charge
- Two held balls allow auto-parry

## Theme

- Early 2000s high-school gym class
- Competitive but funny school flavor
- Gym teacher announcer
- No blood, clean/cartoon dodgeball impacts
- Normal school outfits eventually
- Greybox first

## Main mode

- Ranked-first 1v1
- Private lobbies for testing/friends
- Custom settings private only
- First to 5 hits wins
- 2-minute half-court boundary phase
- After 2 minutes: no-boundaries mode begins with bell, announcer, and lights

## Performance philosophy

Every prototype decision should preserve future competitive multiplayer potential.

Future online version must use:

- authoritative server
- client-side prediction
- server reconciliation
- interpolation
- lag-aware throw/catch validation
- compact network payloads
- no client-authoritative scoring

## Movement target

Inspired by Deadlock, Apex, and Splitgate, but with more freedom.

The player should feel like speed has almost no visible hard cap, but speed must be earned through chaining movement correctly.

Mistakes should bleed momentum.

## Locked mechanics

Refer to `docs/SPEC_LOCKED_DECISIONS.md` for exact mechanics.
