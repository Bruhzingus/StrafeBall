import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
mkdirSync('scripts/shots', { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
 const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.addInitScript(() => localStorage.setItem('strafeball.graphics.mode', 'performance'));
 await page.goto('http://127.0.0.1:5173/', { waitUntil: 'domcontentloaded' });
 await page.waitForSelector('canvas', { timeout: 30000 });
 await page.evaluate(async () => {
  const source = await (await fetch('/src/game/Game.ts')).text();
  const B = await import(source.match(/from "([^"]*babylonjs[^"]*)"/)[1]);
  const { PowerupPresentation, updateSpecialBall } = await import('/src/game/powerups/PowerupPresentation.ts');
  const { SoundManager } = await import('/src/game/audio/SoundManager.ts');
  const { createRoomState } = await import('/shared/simulation/MatchSim.ts');
  const { createPlayerState } = await import('/shared/simulation/PlayerSim.ts');
  const { createBallState } = await import('/shared/simulation/BallSim.ts');
  const { createBallMesh } = await import('/src/game/ball/BallVisualFactory.ts');
  const scene = B.EngineStore.LastCreatedScene, engine = scene.getEngine();
  engine.stopRenderLoop();
  for (const mesh of scene.meshes) if (/portal|dummy|guide|practice|mat_|viewmodel|hands|half_court_cone/.test(mesh.name)) mesh.setEnabled(false);
  const cam = new B.FreeCamera('powerup_review_camera', new B.Vector3(5, 3.4, -7.5), scene); cam.setTarget(new B.Vector3(0, .5, 0)); scene.activeCamera = cam;
  document.querySelectorAll('body > :not(canvas):not(script):not(style)').forEach(e => { if (!e.querySelector('canvas')) e.style.display='none'; });
  const sound = new SoundManager(); const presentation = new PowerupPresentation(scene, sound);
  const room = createRoomState({ players: [createPlayerState('a', 'blue'), createPlayerState('b', 'red')] });
  room.players.a.hasPowerup = true; room.players.b.hasPowerup = true;
  room.players.b.movement.position = {x:-3,y:0,z:1};
  room.players.a.movementInternal.buffs = { speedSeconds: 12, adrenalineSeconds: 12, magnetSeconds: 17, cannonLocked: false };
  room.players.a.armorBallIds=['one','two','three'];
  room.powerups = { spawned: true, waitSeconds: 0, stations: [{id:'review_heal',placerId:'a',teamId:'blue',position:{x:2,y:0,z:1},remainingSeconds:40,progress:{a:6}}] };
  room.match.status='playing';
  const displayBalls = [];
  for (const [i, kind] of ['cannon','bomb','heal'].entries()) {
   const ball = createBallState(kind, {x: -2+i*1.3,y:0.7,z:-1.5},{kind,phase:'held', ...(kind==='bomb'?{armedAtMs:1,fuseSeconds:1}: {})});
   const mesh=createBallMesh(scene,'review_'+kind,new B.Vector3(ball.position.x,ball.position.y,ball.position.z));
   displayBalls.push({mesh,ball});
  }
  const identity = {kind:'bomb',resetSerial:0};
  let time=0;
  engine.runRenderLoop(()=>{time+=1/60;presentation.update(room,'a',{x:0,y:0,z:0},identity,[],1/60);for(const {mesh,ball} of displayBalls){mesh.scaling.setAll(1);updateSpecialBall(mesh,ball,time);}scene.render();});
  window.powerupReview={room,presentation,scene,sound};
 });
 await page.waitForTimeout(2500);
 await page.screenshot({path:'scripts/shots/powerups-models-hud.png'});
 await page.evaluate(()=>{window.powerupReview.room.powerups.spawned=false;window.powerupReview.room.powerups.waitSeconds=10;});
 await page.waitForTimeout(300);
 await page.screenshot({path:'scripts/shots/powerups-respawn-ring.png'});
 console.log(JSON.stringify({errors, screenshots:['powerups-models-hud.png','powerups-respawn-ring.png']}));
 if(errors.length) process.exitCode=1;
} finally { await browser.close(); }
