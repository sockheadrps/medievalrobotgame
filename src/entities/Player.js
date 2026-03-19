import Phaser from 'phaser';
import {
  PLAYER_KEY, PLAYER_SPEED, PLAYER_RUN_SPEED,
  PFRAME_FACE_DOWN, PFRAME_FACE_UP, PFRAME_FACE_RIGHT, PFRAME_FACE_LEFT,
  PFRAME_WALK1_DOWN, PFRAME_WALK1_UP, PFRAME_WALK1_RIGHT, PFRAME_WALK1_LEFT,
  PFRAME_WALK2_DOWN, PFRAME_WALK2_UP, PFRAME_WALK2_RIGHT, PFRAME_WALK2_LEFT,
  PFRAME_STAND_DOWN, PFRAME_STAND_UP, PFRAME_STAND_RIGHT, PFRAME_STAND_LEFT,
  PFRAME_PUNCH_LEFT, PFRAME_PUNCH_RIGHT,
  INTERACT_KEY, TILE_SIZE, PLAYER_FRAME_H,
  KI_MAX_BASE, KI_BLAST_BASE_COST, KI_BLAST_BASE_DMG, KI_BLAST_SCALE,
} from '../constants.js';
import { createBarrierOverlay, syncBarrierOverlay } from './BarrierOverlay.js';
import { createEquipmentOverlay, syncEquipmentOverlay } from './EquipmentOverlay.js';

const HP_REGEN_MS = 30000;
const SCALE = TILE_SIZE / PLAYER_FRAME_H; // 48/32 = 1.5

export class Player extends Phaser.Physics.Arcade.Sprite {

  constructor(scene, x, y) {
    super(scene, x, y, PLAYER_KEY, PFRAME_FACE_DOWN);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 1);
    this.setDepth(2);

    // Disable physics body — movement is server-authoritative
    this.body.enable = false;

    this._createAnims(scene);
    this._facing = 'down';

    this._keys = scene.input.keyboard.addKeys({
      up:       Phaser.Input.Keyboard.KeyCodes.W,
      down:     Phaser.Input.Keyboard.KeyCodes.S,
      left:     Phaser.Input.Keyboard.KeyCodes.A,
      right:    Phaser.Input.Keyboard.KeyCodes.D,
      run:      Phaser.Input.Keyboard.KeyCodes.SHIFT,
      interact: Phaser.Input.Keyboard.KeyCodes[INTERACT_KEY],
    });

    this._interactCallback = null;
    this._keys.interact.on('down', () => {
      if (this._interactCallback) this._interactCallback();
    });

    // Speech bubble
    this._bubble = scene.add.text(x, y, '', {
      fontSize: '9px', color: '#ffffff', backgroundColor: '#00000099',
      padding: { x: 4, y: 3 }, wordWrap: { width: 140 },
    }).setOrigin(0.5, 1).setDepth(10).setVisible(false);
    this._bubbleTimer = null;

    // Stats
    this.maxHp = 20;
    this.hp    = this.maxHp;
    this.str   = 1;
    this.def   = 1;
    this.level = 1;
    this.xp    = 0;
    this._regenAccum = 0;

    // Ki pool
    this.maxKi = KI_MAX_BASE;
    this.ki    = this.maxKi;
    this.infKi = false;
    this.blastLevel = 0;  // tracks how many blasts fired (XP for ki blasts)
    this.kiSkillLevel = 1;
    this.kiSkillXp = 0;
    this.kiMoves = [];
    this.activeKiMode = 'ki_shot'; // current shot type: ki_shot, scatter_shot, explosive_shot

    // Resource counters
    this.logs = 0;
    this.stones = 0;
    this.crystals = 0;
    this.copper = 0;
    this.equipment = {};
    this.kiBlastBonuses = { blast_speed: 0, blast_range: 0, blast_dmg: 0, blast_cooldown: 0, barrier_duration: 0, barrier_cooldown: 0 };
    this._punching = false;
    this._knockedOut = false;
    this._barrierOverlay = createBarrierOverlay(scene, this);
    this._equipOverlays = {};  // slot -> overlay sprite
  }

  _createAnims(scene) {
    const anims = scene.anims;
    const def = (key, frames, fps) => {
      if (anims.exists(key)) return;
      anims.create({
        key,
        frames: frames.map(f => ({ key: PLAYER_KEY, frame: f })),
        frameRate: fps,
        repeat: -1,
      });
    };

    // Walk: face → walk1 → stand → walk2 cycle
    def('walk-down',  [PFRAME_WALK1_DOWN,  PFRAME_FACE_DOWN,  PFRAME_WALK2_DOWN,  PFRAME_FACE_DOWN],  8);
    def('walk-up',    [PFRAME_WALK1_UP,    PFRAME_FACE_UP,    PFRAME_WALK2_UP,    PFRAME_FACE_UP],    8);
    def('walk-left',  [PFRAME_WALK1_LEFT,  PFRAME_FACE_LEFT,  PFRAME_WALK2_LEFT,  PFRAME_FACE_LEFT],  8);
    def('walk-right', [PFRAME_WALK1_RIGHT, PFRAME_FACE_RIGHT, PFRAME_WALK2_RIGHT, PFRAME_FACE_RIGHT], 8);

    // Run: same frames, faster
    def('run-down',  [PFRAME_WALK1_DOWN,  PFRAME_FACE_DOWN,  PFRAME_WALK2_DOWN,  PFRAME_FACE_DOWN],  12);
    def('run-up',    [PFRAME_WALK1_UP,    PFRAME_FACE_UP,    PFRAME_WALK2_UP,    PFRAME_FACE_UP],    12);
    def('run-left',  [PFRAME_WALK1_LEFT,  PFRAME_FACE_LEFT,  PFRAME_WALK2_LEFT,  PFRAME_FACE_LEFT],  12);
    def('run-right', [PFRAME_WALK1_RIGHT, PFRAME_FACE_RIGHT, PFRAME_WALK2_RIGHT, PFRAME_FACE_RIGHT], 12);

  }

  onInteract(callback) {
    this._interactCallback = callback;
  }

  getFacing() { return this._facing; }

  /** Play punch frame toward a target. Uses left/right punch frame without changing facing. */
  playAttack(targetX) {
    if (this._punching) return;
    this._punching = true;

    // Pick punch frame based on target side, but don't change _facing
    const side = targetX < this.x ? 'left' : 'right';
    this.setFlipX(false);
    this.stop();
    this.setFrame(side === 'left' ? PFRAME_PUNCH_LEFT : PFRAME_PUNCH_RIGHT);

    // Hold the punch frame briefly then return to idle
    this.scene.time.delayedCall(300, () => {
      this._punching = false;
    });
  }

  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    this._regenAccum = 0;
    return this.hp <= 0;
  }

  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  showHealEffect(amount = 1) {
    const scene = this.scene;
    if (!scene?.add || !scene?.tweens || amount <= 0) return;
    const healText = scene.add.text(this.x, this.y - this.displayHeight + 2, `+${amount}`, {
      fontSize: '12px', color: '#6dff8a', fontStyle: 'bold',
      backgroundColor: '#103018cc', padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(21);
    scene.tweens.add({
      targets: healText,
      y: healText.y - 18,
      alpha: 0,
      duration: 900,
      onComplete: () => healText.destroy(),
    });
  }

  update(delta) {
    if (this._knockedOut) {
      this.stop();
      this.setTint(0x999999);
      this.setAlpha(0.6);
      syncBarrierOverlay(this._barrierOverlay, this);
      this._syncEquipOverlays();
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      return;
    }
    this.clearTint();
    this.setAlpha(1);

    // HP regen
    if (this.hp < this.maxHp) {
      this._regenAccum += delta;
      if (this._regenAccum >= HP_REGEN_MS) {
        this._regenAccum -= HP_REGEN_MS;
        this.heal(1);
      }
    } else {
      this._regenAccum = 0;
    }

    // Ki regen is server-authoritative (no client-side regen)

    // Freeze animation during attack
    if (this._punching) {
      syncBarrierOverlay(this._barrierOverlay, this);
      this._syncEquipOverlays();
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      return;
    }

    // Block animation while chat input is open
    if (this.scene.chatBox?.isOpen()) {
      syncBarrierOverlay(this._barrierOverlay, this);
      this._syncEquipOverlays();
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      return;
    }

    const keys  = this._keys;
    const isRun = keys.run.isDown;
    let vx = 0, vy = 0;

    if (keys.left.isDown)  vx -= 1;
    if (keys.right.isDown) vx += 1;
    if (keys.up.isDown)    vy -= 1;
    if (keys.down.isDown)  vy += 1;

    const moving = vx !== 0 || vy !== 0;

    if (vx < 0)       this._facing = 'left';
    else if (vx > 0)  this._facing = 'right';
    else if (vy < 0)  this._facing = 'up';
    else if (vy > 0)  this._facing = 'down';

    if (!moving) {
      this.stop();
      const idleFrame = {
        down:  PFRAME_FACE_DOWN,
        up:    PFRAME_FACE_UP,
        left:  PFRAME_FACE_LEFT,
        right: PFRAME_FACE_RIGHT,
      }[this._facing];
      this.setFlipX(false);
      this.setFrame(idleFrame);
      syncBarrierOverlay(this._barrierOverlay, this);
      this._syncEquipOverlays();
      return;
    }

    // Each direction has its own animation — no flipX needed
    this.setFlipX(false);

    let animKey;
    if (this._facing === 'left')       animKey = isRun ? 'run-left'  : 'walk-left';
    else if (this._facing === 'right') animKey = isRun ? 'run-right' : 'walk-right';
    else if (this._facing === 'up')    animKey = isRun ? 'run-up'    : 'walk-up';
    else                               animKey = isRun ? 'run-down'  : 'walk-down';

    if (this.anims.currentAnim?.key !== animKey) this.play(animKey);
    syncBarrierOverlay(this._barrierOverlay, this);
    this._syncEquipOverlays();
    if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
  }

  _syncEquipOverlays() {
    const equipData = this.equipment || {};
    const textures = this.scene?._equipmentTextures || {};
    for (const [slot, eqId] of Object.entries(equipData)) {
      let overlay = this._equipOverlays[slot];
      const texInfo = textures[eqId];
      if (!texInfo || !this.scene.textures.exists(texInfo.textureKey)) {
        if (overlay) { overlay.setVisible(false); }
        continue;
      }
      if (!overlay || overlay._textureKey !== texInfo.textureKey) {
        if (overlay) overlay.destroy();
        overlay = createEquipmentOverlay(this.scene, this, texInfo.textureKey, texInfo.remap);
        this._equipOverlays[slot] = overlay;
      }
      syncEquipmentOverlay(overlay, this);
    }
    // Hide overlays for unequipped slots
    for (const [slot, overlay] of Object.entries(this._equipOverlays)) {
      if (!equipData[slot]) overlay.setVisible(false);
    }
  }

  /** Current ki blast cost, reduced 2% per blast level (compound). */
  getBlastCost() {
    return Math.max(1, Math.round(KI_BLAST_BASE_COST * Math.pow(1 - KI_BLAST_SCALE, this.blastLevel)));
  }

  /** Current ki blast damage, increased 2% per blast level (compound). */
  getBlastDmg() {
    return Math.max(1, Math.round(KI_BLAST_BASE_DMG * Math.pow(1 + KI_BLAST_SCALE, this.blastLevel)));
  }

  /** Check if a ki blast can be fired. Does NOT spend ki (server-authoritative). */
  canBlast() {
    if (this.infKi) return true;
    return this.ki >= this.getBlastCost();
  }

  hasKiMove(moveId) {
    return (this.kiMoves || []).includes(moveId);
  }

  /** Cycle to next available ki shot mode. Returns the new mode name. */
  cycleKiMode() {
    const modes = ['ki_shot']; // always available
    if (this.hasKiMove('scatter_shot'))   modes.push('scatter_shot');
    if (this.hasKiMove('explosive_shot')) modes.push('explosive_shot');
    if (modes.length <= 1) return this.activeKiMode;
    const idx = modes.indexOf(this.activeKiMode);
    this.activeKiMode = modes[(idx + 1) % modes.length];
    return this.activeKiMode;
  }

  showBubble(text, durationMs = 5000) {
    if (!this._bubble) return;
    this._bubble.setText(text).setVisible(true);
    if (this._bubbleTimer) this._bubbleTimer.remove();
    this._bubbleTimer = this.scene.time.delayedCall(durationMs, () => {
      if (this._bubble) this._bubble.setVisible(false);
      this._bubbleTimer = null;
    });
  }

  destroy(fromScene) {
    this._destroyed = true;
    this._barrierOverlay?.destroy();
    for (const overlay of Object.values(this._equipOverlays || {})) overlay?.destroy();
    this._equipOverlays = {};
    this._bubble?.destroy();
    super.destroy(fromScene);
  }
}
