// RefineStoneHelper.js — handles the refine_stone task sub-phases
// Extracted from NPCTaskRunner.js. Receives (scene, npc, runner) in constructor.

import Phaser from 'phaser';
import { TILE_SIZE } from '../../constants.js';

export class RefineStoneHelper {
  constructor(scene, npc, runner) {
    this._scene = scene;
    this._npc = npc;
    this._runner = runner;
  }

  // ── Refine Stone dispatcher ──────────────────────────────────────────────────

  doRefineStone(_delta) {
    const runner = this._runner;
    const cmd = runner._tasks[0];

    if (!cmd._refinePhase) cmd._refinePhase = 'find_anvil';

    switch (cmd._refinePhase) {
      case 'find_anvil':      this._refine_findAnvil(cmd); break;
      case 'walk_to_anvil':   this._refine_walkToAnvil(cmd); break;
      case 'refining':        this._refine_refining(cmd, _delta); break;
      case 'wait_for_player': this._refine_waitForPlayer(cmd, _delta); break;
      case 'walk_to_player':  this._refine_walkToPlayer(cmd); break;
      case 'report':          this._refine_report(cmd); break;
      default:
        runner._tasks.shift();
    }
  }

  _refine_findAnvil(cmd) {
    const scene = this._scene;
    const npc = this._npc;
    const runner = this._runner;

    if ((npc.stones || 0) < 1) {
      npc.showBubble("I don't have any stone to refine!", 2500);
      runner._tasks.shift();
      return;
    }

    let bestDist = Infinity;
    let bestAnvil = null;
    for (const [aid, sprite] of Object.entries(scene._anvilSprites || {})) {
      const d = Phaser.Math.Distance.Between(npc.x, npc.y, sprite.x, sprite.y);
      if (d < bestDist) {
        bestDist = d;
        bestAnvil = { id: aid, x: sprite.x, y: sprite.y };
      }
    }

    if (!bestAnvil) {
      npc.showBubble("I can't find an anvil!", 2500);
      runner._tasks.shift();
      return;
    }

    cmd._anvilId = bestAnvil.id;
    cmd._anvilX = bestAnvil.x;
    cmd._anvilY = bestAnvil.y;
    cmd._totalBastalite = 0;
    cmd._totalCrystalPristine = 0;
    cmd._totalCrystalNormal = 0;
    cmd._totalCrystalPoor = 0;
    cmd._refineCount = 0;
    cmd._refinePhase = 'walk_to_anvil';
    npc.showBubble('Heading to the anvil!', 2000);
  }

  _refine_walkToAnvil(cmd) {
    const npc = this._npc;
    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, cmd._anvilX, cmd._anvilY);
    if (dist > TILE_SIZE * 1.2) {
      npc.moveTo(cmd._anvilX, cmd._anvilY);
    } else {
      npc.stopMoving();
      cmd._refinePhase = 'refining';
      cmd._refineCooldown = 0;
      npc.showBubble('Time to refine!', 1500);
    }
  }

  _refine_refining(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;

    cmd._refineCooldown = (cmd._refineCooldown || 0) - _delta;
    if (cmd._refineCooldown > 0) return;

    if ((npc.stones || 0) < 1) {
      npc.showBubble('All out of stone!', 2000);
      cmd._refinePhase = 'wait_for_player';
      cmd._waitTimer = 0;
      return;
    }

    const anvilSprite = scene._anvilSprites?.[cmd._anvilId];
    if (!anvilSprite) {
      npc.showBubble('The anvil is gone!', 2000);
      cmd._refinePhase = 'wait_for_player';
      cmd._waitTimer = 0;
      return;
    }

    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'npc_refine_rock', anvil_id: cmd._anvilId, npc_id: npc.id });
    }

    npc.stones = Math.max(0, (npc.stones || 0) - 1);
    cmd._refineCount++;

    const commentary = [
      'Refining...', 'Hammering away...', "Let's see what we get...",
      'Working the stone...', 'Almost...', 'Clang!',
    ];
    npc.showBubble(commentary[Math.floor(Math.random() * commentary.length)], 1000, { silent: true });
    cmd._refineCooldown = 1200;
  }

  _refine_waitForPlayer(cmd, _delta) {
    const npc = this._npc;
    const scene = this._scene;
    const player = scene.player;
    if (!player) return;

    cmd._waitTimer = (cmd._waitTimer || 0) + _delta;

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist <= TILE_SIZE * 5) {
      cmd._refinePhase = 'walk_to_player';
      return;
    }

    if (cmd._waitTimer > 5000) {
      cmd._waitTimer = 0;
      const lines = [
        'Waiting for the boss...', "Where'd they go?",
        "I'll wait here...", 'Finished refining!',
      ];
      npc.showBubble(lines[Math.floor(Math.random() * lines.length)], 2500, { silent: true });
    }
  }

  _refine_walkToPlayer(cmd) {
    const npc = this._npc;
    const runner = this._runner;
    const player = this._scene.player;
    if (!player) return;

    const dist = Phaser.Math.Distance.Between(npc.x, npc.y, player.x, player.y);
    if (dist > runner._getFollowLeash()) {
      npc.moveTo(player.x, player.y);
    } else {
      npc.stopMoving();
      cmd._refinePhase = 'report';
    }
  }

  _refine_report(cmd) {
    const npc = this._npc;
    const scene = this._scene;
    const runner = this._runner;

    const conn = scene._conn;
    if (conn?.connected) {
      conn.send({ type: 'npc_give_materials', npc_id: npc.id });
    }

    let msg;
    if ((npc.crystals || 0) > 0) {
      msg = `Done refining ${cmd._refineCount} stone! Got: ${npc.crystals} Crystal${npc.crystals > 1 ? 's' : ''}. Here you go!`;
    } else {
      msg = `Refined ${cmd._refineCount} stone but didn't find anything good. Sorry boss!`;
    }

    npc.showBubble(msg, 5000);
    scene.chatBox?._addLog(`${npc.getName()}: ${msg}`, '#44eeff');

    npc.crystals = 0;
    npc.stones = 0;

    runner._tasks.shift();
  }
}
