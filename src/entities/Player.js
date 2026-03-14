import Phaser from 'phaser';
import {
  PLAYER_KEY, PLAYER_SPEED, PLAYER_RUN_SPEED,
  PFRAME_FACE_DOWN, PFRAME_FACE_UP, PFRAME_FACE_RIGHT, PFRAME_FACE_LEFT,
  PFRAME_WALK1_DOWN, PFRAME_WALK1_UP, PFRAME_WALK1_RIGHT, PFRAME_WALK1_LEFT,
  PFRAME_WALK2_DOWN, PFRAME_WALK2_UP, PFRAME_WALK2_RIGHT, PFRAME_WALK2_LEFT,
  PFRAME_STAND_DOWN, PFRAME_STAND_UP, PFRAME_STAND_RIGHT, PFRAME_STAND_LEFT,
  PFRAME_MEDITATE, PFRAME_PUNCH_LEFT, PFRAME_PUNCH_RIGHT,
  INTERACT_KEY, TILE_SIZE, PLAYER_FRAME_H,
  KI_MAX_BASE, KI_BLAST_BASE_COST, KI_BLAST_BASE_DMG, KI_BLAST_SCALE, KI_SKILL_MEDITATE_UNLOCK_LEVEL,
} from '../constants.js';
import { createArmorOverlay, getPlayerArmorFrameName, syncArmorOverlay } from './ArmorOverlay.js';
import { createAuraOverlay, syncAuraOverlay } from './AuraOverlay.js';
import { createBarrierOverlay, syncBarrierOverlay } from './BarrierOverlay.js';
import {
  applyActorChargeState,
  applyActorMeditationState,
  getEquippedActorKiAugment,
  hasActorKiAugment,
  hasActorKiDenomination,
  hasActorKiMove,
  initializeActorKiState,
} from './actorKiState.js';

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
    this._meditationLabel = scene.add.text(x, y, '', {
      fontSize: '9px', color: '#99ddff', backgroundColor: '#001122aa',
      padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 1).setDepth(11).setVisible(false);
    this._meditationBarBg = scene.add.rectangle(x, y, 34, 4, 0x112233, 0.95)
      .setDepth(11).setVisible(false);
    this._meditationBar = scene.add.rectangle(x - 17, y, 34, 4, 0x66bbff, 0.95)
      .setOrigin(0, 0.5).setDepth(12).setVisible(false);

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
    this.realmTier = 0;
    this.realmCrystalT1 = 0;
    this.kiMoves = [];
    initializeActorKiState(this, { includeClairvoyance: true });

    // Resource counters
    this.logs = 0;
    this.stones = 0;
    this.bastalite = 0;
    this.crystalPristine = 0;
    this.crystalNormal = 0;
    this.crystalPoor = 0;
    this._punching = false;
    this._knockedOut = false;
    this.armorElite = false;
    this.armorEliteInv = false;  // armor in inventory but not equipped
    this._armorOverlay = createArmorOverlay(scene, this);
    this._auraOverlay = createAuraOverlay(scene, this);
    this._barrierOverlay = createBarrierOverlay(scene, this);
    this._refreshArmorOverlay();
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

  setArmorElite(on) {
    const prev = this.armorElite;
    this.armorElite = !!on;
    if (!!on !== prev) console.log(`[Player] armorElite: ${prev} -> ${!!on}`);
    this._refreshArmorOverlay();
  }

  canMeditate() {
    return (this.kiSkillLevel ?? 1) >= KI_SKILL_MEDITATE_UNLOCK_LEVEL;
  }

  setMeditationState(state = {}) {
    applyActorMeditationState(this, state, () => this._updateMeditationVisuals());
  }

  setChargeState(state = {}) {
    applyActorChargeState(this, state, { includeClairvoyance: true, facingFallback: this._facing });
  }

  hasKiMove(moveId) {
    return hasActorKiMove(this, moveId);
  }

  hasKiDenomination(denominationId) {
    return hasActorKiDenomination(this, denominationId);
  }

  hasKiAugment(moveId, augmentId) {
    return hasActorKiAugment(this, moveId, augmentId);
  }

  getEquippedKiAugment(moveId) {
    return getEquippedActorKiAugment(this, moveId);
  }

  _refreshArmorOverlay() {
    syncArmorOverlay(this._armorOverlay, this, getPlayerArmorFrameName(this), this.armorElite && !this._destroyed);
  }

  _updateMeditationVisuals() {
    const active = !!this.meditating;
    const nowSec = Date.now() / 1000;
    const totalSec = Math.max(0.001, this.meditationTotalMs / 1000);
    const remaining = Math.max(0, this.meditationUntil - nowSec);
    const pct = Phaser.Math.Clamp(remaining / totalSec, 0, 1);
    this._meditationLabel?.setVisible(active).setText(active ? `Meditating ${Math.ceil(remaining)}s` : '');
    this._meditationBarBg?.setVisible(active);
    this._meditationBar?.setVisible(active);
    this._meditationLabel?.setPosition(this.x, this.y - this.displayHeight - 10);
    this._meditationBarBg?.setPosition(this.x, this.y - this.displayHeight + 2);
    this._meditationBar?.setPosition(this.x - 17, this.y - this.displayHeight + 2);
    this._meditationBar?.setDisplaySize(34 * pct, 4);
  }

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
      this._refreshArmorOverlay();
      syncAuraOverlay(this._auraOverlay, this, false);
      syncBarrierOverlay(this._barrierOverlay, this);
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      this._updateMeditationVisuals();
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

    if (this.meditating) {
      this.stop();
      this.setFlipX(false);
      this.setFrame(PFRAME_MEDITATE);
      this._refreshArmorOverlay();
      syncAuraOverlay(this._auraOverlay, this, false);
      syncBarrierOverlay(this._barrierOverlay, this);
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      this._updateMeditationVisuals();
      return;
    }

    // Freeze animation during attack
    if (this._punching) {
      this._refreshArmorOverlay();
      syncAuraOverlay(this._auraOverlay, this, this.charging || this.chargePower > 0.01);
      syncBarrierOverlay(this._barrierOverlay, this);
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      return;
    }

    // Block animation while chat input is open
    if (this.scene.chatBox?.isOpen()) {
      this._refreshArmorOverlay();
      syncAuraOverlay(this._auraOverlay, this, this.charging || this.chargePower > 0.01);
      syncBarrierOverlay(this._barrierOverlay, this);
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
      this._refreshArmorOverlay();
      syncAuraOverlay(this._auraOverlay, this, this.charging || this.chargePower > 0.01);
      syncBarrierOverlay(this._barrierOverlay, this);
      this._updateMeditationVisuals();
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
    this._refreshArmorOverlay();
    syncAuraOverlay(this._auraOverlay, this, this.charging || this.chargePower > 0.01);
    syncBarrierOverlay(this._barrierOverlay, this);
    if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
    this._updateMeditationVisuals();
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
    this._armorOverlay?.destroy();
    this._auraOverlay?.destroy();
    this._bubble?.destroy();
    this._meditationLabel?.destroy();
    this._meditationBar?.destroy();
    this._meditationBarBg?.destroy();
    super.destroy(fromScene);
  }
}
