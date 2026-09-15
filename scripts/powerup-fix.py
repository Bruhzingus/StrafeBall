from pathlib import Path
p=Path('src/game/scenes/ArenaScene.ts');p.write_text(p.read_text(encoding='utf-8').replace('this.player.movement.state.position','this.player.root.position'),encoding='utf-8')
