# Models

Drop `.glb` files here to upgrade greybox visuals to real models.

Wiring (no gameplay changes needed):

1. Add the filename to the matching entry's `glb` field in
   [`src/game/assets/AssetManifest.ts`](../../../src/game/assets/AssetManifest.ts)
   (e.g. `mat: { ..., glb: 'dodgeball_mat.glb' }`).
2. Have the call site use `await loader.loadModel(key, opts)` instead of
   `loader.createVisual(key, opts)` where async creation is acceptable.

Collision/hit logic uses proxy shapes (AABBs, radii), not model geometry, so visuals can be
swapped freely without affecting movement, throws, catches, or scoring.

Files in `public/` are served from the site root, so a file here is reachable at
`/assets/models/<file>.glb` — which is what `ModelLoader.loadModel` requests.
