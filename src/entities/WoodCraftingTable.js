import Phaser from 'phaser';
import {
  SHEET_KEY, TILE_SIZE, SHEET_TILE, INTERACT_DIST, FRAME_WOOD_BUILDING,
} from '../constants.js';

const SCALE = TILE_SIZE / SHEET_TILE;
const CRAFT_MS_PER = 1000;

export class WoodCraftingTable extends Phaser.GameObjects.Image {
  constructor(scene, col, row) {
    const x = col * TILE_SIZE + TILE_SIZE / 2;
    const y = row * TILE_SIZE + TILE_SIZE / 2;
    super(scene, x, y, SHEET_KEY, FRAME_WOOD_BUILDING);
    scene.add.existing(this);
    this.setDepth(1).setScale(SCALE).setTint(0xbd8e58);

    this.col = col;
    this.row = row;
    this._panel = null;

    this._queued = 0;
    this._output = 0;
    this._crafting = false;
    this._progressMs = 0;

    this.setInteractive({ useHandCursor: true });
    this.on('pointerdown', (ptr) => {
      if (ptr.event.ctrlKey) {
        scene.events.emit('object-ctrl-clicked', { type: 'wood_crafting_table', obj: this });
      } else if (ptr.rightButtonDown()) {
        scene.events.emit('object-right-clicked', { type: 'wood_crafting_table', obj: this, ptr });
      } else {
        scene.events.emit('wood-crafting-table-clicked', this);
      }
    });

    this._label = scene.add.text(x, y - TILE_SIZE / 2 - 4, 'WOOD TABLE', {
      fontSize: '10px', color: '#e3c08f', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._prompt = scene.add.text(x, y - TILE_SIZE / 2 - 18, '[E] Craft', {
      fontSize: '10px', color: '#ffffff', align: 'center',
      backgroundColor: '#00000088', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(3).setVisible(false);

    this._status = scene.add.text(x, y + TILE_SIZE / 2 + 2, '', {
      fontSize: '9px', color: '#e3c08f', align: 'center',
      backgroundColor: '#00000099', padding: { x: 3, y: 1 },
    }).setOrigin(0.5, 0).setDepth(3).setVisible(false);

    const BAR_W = TILE_SIZE - 4;
    const BAR_H = 4;
    const barY = y + TILE_SIZE / 2 + 14;
    this._barBg = scene.add.rectangle(x, barY, BAR_W, BAR_H, 0x222233).setDepth(3).setOrigin(0.5, 0).setVisible(false);
    this._barFill = scene.add.rectangle(x - BAR_W / 2, barY, 0, BAR_H, 0xd4ac73).setDepth(4).setOrigin(0, 0).setVisible(false);
    this._barW = BAR_W;
  }

  setPanel(panel) { this._panel = panel; }
  openPanel() { this._panel?.open(this); }

  update(delta) {
    if (!this._crafting && this._queued > 0) {
      this._crafting = true;
      this._progressMs = 0;
    }
    if (!this._crafting) {
      this._updateStatus();
      return;
    }
    this._progressMs += delta;
    if (this._progressMs >= CRAFT_MS_PER) {
      this._progressMs -= CRAFT_MS_PER;
      this._queued = Math.max(0, this._queued - 1);
      this._output += 1;
      if (this._queued <= 0) {
        this._crafting = false;
        this._progressMs = 0;
      }
      this._panel?._refresh?.();
    }
    this._updateStatus();
  }

  updateProximity(playerX, playerY) {
    const dist = Phaser.Math.Distance.Between(playerX, playerY, this.x, this.y);
    const inRange = dist <= INTERACT_DIST;
    const adjacent = dist <= TILE_SIZE * 1.5;
    const show = this.scene.labelsVisible ?? true;
    this._prompt.setVisible(inRange && show);
    this._label.setVisible(adjacent && show);
    this._status.setVisible(adjacent && show);
    this._barBg.setVisible(adjacent && show && this._crafting);
    this._barFill.setVisible(adjacent && show && this._crafting);
    return inRange;
  }

  refreshLabels(visible) {
    if (!visible) {
      this._prompt.setVisible(false);
      this._label.setVisible(false);
      this._status.setVisible(false);
      this._barBg.setVisible(false);
      this._barFill.setVisible(false);
    }
  }

  queueCrafts(inventory, count) {
    const availableWood = typeof inventory.get === 'function' ? inventory.get('Wood') : (inventory.Wood ?? 0);
    const canQueue = Math.max(0, Math.min(count, availableWood));
    if (canQueue <= 0) return 0;
    if (typeof inventory.remove === 'function') inventory.remove('Wood', canQueue);
    else inventory.Wood = Math.max(0, availableWood - canQueue);
    this._queued += canQueue;
    this._updateStatus();
    return canQueue;
  }

  pickupOutput(inventory, skillSystem, amount) {
    const want = Math.max(1, amount | 0);
    const take = Math.min(this._output, want);
    if (take <= 0) return 0;
    const added = typeof inventory.add === 'function'
      ? inventory.add('WoodPulpConveyor', take)
      : take;
    if (added <= 0) return 0;
    this._output -= added;
    // XP is granted when output is collected.
    skillSystem?.awardXP?.('crafting', added * 4, this.scene);
    this._updateStatus();
    return added;
  }

  getQueued() { return this._queued; }
  getOutput() { return this._output; }
  isCrafting() { return this._crafting; }
  getCraftProgress() { return this._crafting ? Math.min(1, this._progressMs / CRAFT_MS_PER) : 0; }

  serialise() {
    return {
      col: this.col,
      row: this.row,
      queued: this._queued,
      output: this._output,
      crafting: this._crafting,
      progressMs: this._progressMs,
    };
  }

  deserialise(data) {
    this._queued = data?.queued ?? 0;
    this._output = data?.output ?? 0;
    this._crafting = !!data?.crafting;
    this._progressMs = data?.progressMs ?? 0;
    this._updateStatus();
  }

  _updateStatus() {
    if (this._crafting) {
      const pct = Math.round(this.getCraftProgress() * 100);
      this._status.setText(`Pulping ${pct}%  Q:${this._queued}  Out:${this._output}`);
      this._barFill.setDisplaySize(Math.round(this._barW * this.getCraftProgress()), 4);
    } else {
      this._status.setText(`Q:${this._queued}  Out:${this._output}`);
      this._barFill.setDisplaySize(0, 4);
    }
  }

  destroy(fromScene) {
    this._label?.destroy();
    this._prompt?.destroy();
    this._status?.destroy();
    this._barBg?.destroy();
    this._barFill?.destroy();
    super.destroy(fromScene);
  }
}

