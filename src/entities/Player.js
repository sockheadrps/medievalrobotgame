import Phaser from 'phaser';
import {
  PLAYER_KEY, PLAYER_SPEED, PLAYER_RUN_SPEED,
  PANIM_WALK_DOWN, PANIM_WALK_UP, PANIM_WALK_LEFT,
  PANIM_RUN_DOWN, PANIM_RUN_UP, PANIM_RUN_LEFT,
  INTERACT_KEY, TILE_SIZE, PLAYER_FRAME_H,
  ENCUMBRANCE_THRESHOLD, MAX_SPEED_PENALTY, ATHLETICS_XP_INTERVAL_MS,
} from '../constants.js';

// HP formula: 10 + (constitutionLevel * 5)
// Regen: 1 HP every 30 000 ms out of combat
const HP_REGEN_MS = 30000;

// 32px frame height → scale to 48px tile
const SCALE = TILE_SIZE / PLAYER_FRAME_H; // 1.5

export class Player extends Phaser.Physics.Arcade.Sprite {

  constructor(scene, x, y) {
    // Start on idle frame: center frame (col 1) of walk-down row
    super(scene, x, y, PLAYER_KEY, PANIM_WALK_DOWN * 3 + 1);
    scene.add.existing(this);
    scene.physics.add.existing(this);

    this.setScale(SCALE);
    this.setOrigin(0.5, 1);          // anchor at feet (bottom-center)
    this.setSize(10, 12);            // narrow body covering lower half
    this.setOffset(3, 16);           // start body at y=16 in frame space
    this.setCollideWorldBounds(true);
    this.setDepth(2);

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

    // HP — wired to Constitution skill via setConstitutionLevel()
    this.maxHp       = 15;   // default: Constitution level 1
    this.hp          = this.maxHp;
    this._regenAccum = 0;    // ms accumulated toward next regen tick

    // Athletics / encumbrance
    this._athleticsLevel   = 1;
    this._athleticsXpAccum = 0;  // ms accumulated toward next Athletics XP tick
  }

  _createAnims(scene) {
    const anims = scene.anims;
    const def = (key, row, fps) => {
      if (anims.exists(key)) return;
      anims.create({
        key,
        frames: anims.generateFrameNumbers(PLAYER_KEY, { start: row * 3, end: row * 3 + 2 }),
        frameRate: fps,
        repeat: -1,
      });
    };

    def('walk-down', PANIM_WALK_DOWN, 8);
    def('walk-up',   PANIM_WALK_UP,   8);
    def('walk-side', PANIM_WALK_LEFT, 8);   // used for both left & right (flip for right)
    def('run-down',  PANIM_RUN_DOWN,  12);
    def('run-up',    PANIM_RUN_UP,    12);
    def('run-side',  PANIM_RUN_LEFT,  12);  // used for both left & right (flip for right)
  }

  onInteract(callback) {
    this._interactCallback = callback;
  }

  // ── HP API ────────────────────────────────────────────────────────────────

  /** Call whenever Constitution level changes. Preserves HP% if possible. */
  setConstitutionLevel(lvl) {
    const prev = this.maxHp;
    this.maxHp = 10 + lvl * 5;
    // Scale current HP proportionally (don't exceed new max)
    this.hp = Math.min(this.hp + (this.maxHp - prev), this.maxHp);
  }

  /** Deal damage to the player. Returns true if player died. */
  takeDamage(amount) {
    this.hp = Math.max(0, this.hp - amount);
    this._regenAccum = 0;   // reset regen on hit
    return this.hp <= 0;
  }

  /** Heal the player up to maxHp. */
  heal(amount) {
    this.hp = Math.min(this.maxHp, this.hp + amount);
  }

  // ── Athletics API ─────────────────────────────────────────────────────────

  setAthleticsLevel(lvl) {
    this._athleticsLevel = lvl;
  }

  /** Returns 0-1 encumbrance ratio. 0 = no penalty, 1 = max penalty. */
  getEncumbrance() {
    const inv = this.scene?.inventory;
    if (!inv) return 0;
    const weight   = inv.getTotalWeight();
    const capacity = inv.getWeightCapacity();
    if (capacity <= 0) return 0;
    const threshold = capacity * ENCUMBRANCE_THRESHOLD;
    if (weight <= threshold) return 0;
    return Math.min(1, (weight - threshold) / (capacity - threshold));
  }

  update(delta) {
    // HP regen — 1 HP every HP_REGEN_MS ms out of combat
    if (this.hp < this.maxHp) {
      this._regenAccum += delta;
      if (this._regenAccum >= HP_REGEN_MS) {
        this._regenAccum -= HP_REGEN_MS;
        this.heal(1);
      }
    } else {
      this._regenAccum = 0;
    }

    const keys  = this._keys;
    const isRun = keys.run.isDown;
    let vx = 0, vy = 0;

    if (keys.left.isDown)  vx -= 1;
    if (keys.right.isDown) vx += 1;
    if (keys.up.isDown)    vy -= 1;
    if (keys.down.isDown)  vy += 1;

    if (vx !== 0 && vy !== 0) { vx /= Math.SQRT2; vy /= Math.SQRT2; }

    // Encumbrance speed modifier
    const encumbrance = this.getEncumbrance();
    const speedMult   = 1 - encumbrance * MAX_SPEED_PENALTY;
    const baseSpeed   = isRun ? PLAYER_RUN_SPEED : PLAYER_SPEED;
    const speed       = baseSpeed * speedMult;

    this.setVelocity(vx * speed, vy * speed);

    const moving = vx !== 0 || vy !== 0;

    // Athletics XP — award while moving with weight
    if (moving) {
      const inv = this.scene?.inventory;
      const weight = inv?.getTotalWeight() ?? 0;
      if (weight > 0) {
        this._athleticsXpAccum += delta;
        if (this._athleticsXpAccum >= ATHLETICS_XP_INTERVAL_MS) {
          this._athleticsXpAccum -= ATHLETICS_XP_INTERVAL_MS;
          const xp = Math.max(1, Math.floor(weight / 20));
          this.scene?.skillSystem?.awardXP('athletics', xp, this.scene);
        }
      }
    } else {
      this._athleticsXpAccum = 0;
    }

    // Update facing — horizontal takes priority for side animations
    if (vx < 0)       this._facing = 'left';
    else if (vx > 0)  this._facing = 'right';
    else if (vy < 0)  this._facing = 'up';
    else if (vy > 0)  this._facing = 'down';

    if (!moving) {
      this.stop();
      // Idle = center frame of the appropriate walk row
      const idleRow = {
        down:  PANIM_WALK_DOWN,
        up:    PANIM_WALK_UP,
        left:  PANIM_WALK_LEFT,
        right: PANIM_WALK_LEFT,  // same row, flipped
      }[this._facing];
      this.setFlipX(this._facing === 'right');
      this.setFrame(idleRow * 3 + 1);
      return;
    }

    const isSide = this._facing === 'left' || this._facing === 'right';
    this.setFlipX(this._facing === 'right');

    let animKey;
    if (isSide)              animKey = isRun ? 'run-side' : 'walk-side';
    else if (this._facing === 'up')   animKey = isRun ? 'run-up'   : 'walk-up';
    else                     animKey = isRun ? 'run-down' : 'walk-down';

    if (this.anims.currentAnim?.key !== animKey) this.play(animKey);
    // Keep speech bubble above head
    if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
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
}
