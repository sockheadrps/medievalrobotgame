import Phaser from 'phaser';
import { TILE_SIZE, DINOBIRD_KEY } from '../constants.js';

// Registry: species key -> spritesheet key + frame layout
const ANIMAL_REGISTRY = {
  dinobird: {
    key: DINOBIRD_KEY,
    scale: TILE_SIZE / 32,
    hp: 20,
    frames: {
      walk_down:  [0, 4],
      walk_up:    [1, 5],
      walk_right: [2, 6],
      walk_left:  [3, 7],
    },
  },
};

export class AnimalEntity extends Phaser.GameObjects.Sprite {
  constructor(scene, x, y, species) {
    const def = ANIMAL_REGISTRY[species] ?? ANIMAL_REGISTRY.dinobird;
    super(scene, x, y, def.key, 0);
    scene.add.existing(this);

    this._species = species;
    this._def = def;
    this._serverId = null;
    this._dead = false;

    this.setScale(def.scale);
    this.setDepth(5);

    // HP bar
    this._hpBar = scene.add.graphics();
    this._hpBar.setDepth(6);

    this._ensureAnims(scene, def);
    this.play(`${species}_walk_down`);
  }

  _ensureAnims(scene, def) {
    for (const [name, framePair] of Object.entries(def.frames)) {
      const key = `${this._species}_${name}`;
      if (!scene.anims.exists(key)) {
        scene.anims.create({
          key,
          frames: scene.anims.generateFrameNumbers(def.key, { frames: framePair }),
          frameRate: 4,
          repeat: -1,
        });
      }
    }
  }

  applyState(sa) {
    this.x = sa.x;
    this.y = sa.y;
    this._dead = !!sa.dead;
    this.setVisible(!this._dead);
    this._hpBar.setVisible(!this._dead);

    // Direction-based animation
    const dx = sa.dx ?? 0;
    const dy = sa.dy ?? 0;
    let dir = 'down';
    if (Math.abs(dx) > Math.abs(dy)) dir = dx > 0 ? 'right' : 'left';
    else if (dy < 0) dir = 'up';

    const animKey = `${this._species}_walk_${dir}`;
    if (this.anims.currentAnim?.key !== animKey) this.play(animKey, true);

    // HP bar
    this._drawHpBar(sa.hp ?? 0, sa.maxHp ?? this._def.hp);
  }

  _drawHpBar(hp, maxHp) {
    const g = this._hpBar;
    g.clear();
    if (hp >= maxHp) return;
    const bw = TILE_SIZE * 0.8;
    const bh = 4;
    const bx = this.x - bw / 2;
    const by = this.y - TILE_SIZE * 0.7;
    g.fillStyle(0x333333);
    g.fillRect(bx, by, bw, bh);
    const pct = Math.max(0, hp / maxHp);
    g.fillStyle(pct > 0.5 ? 0x44ff44 : pct > 0.25 ? 0xffaa00 : 0xff3333);
    g.fillRect(bx, by, bw * pct, bh);
  }

  destroy() {
    this._hpBar?.destroy();
    super.destroy();
  }
}
