from pathlib import Path
p=Path('scripts/powerups-visual-check.mjs');s=p.read_text(encoding='utf-8').replace("const B = await import('/node_modules/.vite/deps/@babylonjs_core.js');", "const source = await (await fetch('/src/game/Game.ts')).text();\n  const B = await import(source.match(/from \"([^\"]*babylonjs[^\"]*)\"/)[1]);");p.write_text(s,encoding='utf-8')
