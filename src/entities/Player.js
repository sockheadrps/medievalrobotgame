import Phaser from 'phaser';
import {
  PLAYER_KEY, PLAYER_SPEED, PLAYER_RUN_SPEED,
  PFRAME_FACE_DOWN, PFRAME_FACE_UP, PFRAME_FACE_RIGHT, PFRAME_FACE_LEFT,
  PFRAME_WALK1_DOWN, PFRAME_WALK1_UP, PFRAME_WALK1_RIGHT, PFRAME_WALK1_LEFT,
  PFRAME_WALK2_DOWN, PFRAME_WALK2_UP, PFRAME_WALK2_RIGHT, PFRAME_WALK2_LEFT,
  PFRAME_STAND_DOWN, PFRAME_STAND_UP, PFRAME_STAND_RIGHT, PFRAME_STAND_LEFT,
  PFRAME_PUNCH_LEFT, PFRAME_PUNCH_RIGHT,
  INTERACT_KEY, TILE_SIZE, PLAYER_FRAME_H,
} from '../constants.js';

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

    // Simple log counter
    this.logs = 0;
    this._punching = false;
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

  update(delta) {
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

    // Freeze animation during attack
    if (this._punching) {
      if (this._bubble) this._bubble.setPosition(this.x, this.y - this.displayHeight + 4);
      return;
    }

    // Block animation while chat input is open
    if (this.scene.chatBox?.isOpen()) {
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
