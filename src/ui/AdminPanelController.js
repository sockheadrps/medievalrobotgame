import { NPC } from '../entities/NPC.js';
import { NPCTaskRunner } from '../systems/NPCTaskRunner.js';
import { NPCBrain } from '../systems/NPCBrain.js';
import { TILE_SIZE, tilePos } from '../constants.js';

const IMPLEMENTED_KI_MOVES = [
  { id: 'ki_shot', label: 'Ki Shot' },
  { id: 'scatter_shot', label: 'Scatter Shot' },
  { id: 'explosive_shot', label: 'Explosive Shot' },
  { id: 'barrier', label: 'Barrier' },
  { id: 'sense_ki', label: 'Sense Ki' },
];

export class AdminPanelController {
  constructor(scene) {
    this.scene = scene;
  }

  toggleAdmin() {
    if (this.scene._adminOpen) this.closeAdmin();
    else {
      this.scene._adminPage = 1;
      this.openAdmin();
    }
  }

  openAdmin() {
    this.scene._adminOpen = true;
    this.renderAdminPanel();
  }

  getAdminTargetNpc() {
    const scene = this.scene;
    return scene.selectedNPC && !scene.selectedNPC.isDead?.() ? scene.selectedNPC : null;
  }

  getAdminTargetActor() {
    return this.getAdminTargetNpc() || this.scene.player;
  }

  sendAdmin(field, value = 0, extra = {}) {
    const targetNpc = this.getAdminTargetNpc();
    this.scene._conn.send({
      type: 'admin',
      field,
      value,
      target_npc_id: targetNpc?.id || null,
      ...extra,
    });
  }

  renderAdminPanel() {
    const scene = this.scene;
    if (scene._adminPanel) {
      for (const el of scene._adminPanel) {
        scene.removeHud(el);
        el.destroy();
      }
      scene._adminPanel = null;
    }
    const W = scene._screenWidth();
    const H = scene._screenHeight();
    const page = scene._adminPage || 1;
    const targetNpc = this.getAdminTargetNpc();
    const actor = this.getAdminTargetActor();
    const targetName = targetNpc ? targetNpc.getName() : 'Player';
    const items = [
      { label: '+10 Logs', action: () => this.sendAdmin('logs', 10) },
      { label: '+50 Logs', action: () => this.sendAdmin('logs', 50) },
      { label: '+10 Stone', action: () => this.sendAdmin('stones', 10) },
      { label: '+10 Copper', action: () => this.sendAdmin('copper', 10) },
      { label: '+10 Crystals', action: () => this.sendAdmin('crystals', 10) },
      { label: '+10 Seeds', action: () => this.sendAdmin('seeds', 10) },
      { label: 'Full HP', action: () => this.sendAdmin('full_hp', 0) },
      { label: '+5 Max HP', action: () => this.sendAdmin('maxHp', 5) },
      { label: 'Full Ki', action: () => this.sendAdmin('full_ki', 0) },
      { label: '+5 Max Ki', action: () => this.sendAdmin('maxKi', 5) },
      { label: '+1 STR', action: () => this.sendAdmin('str', 1) },
      { label: '+1 DEF', action: () => this.sendAdmin('def', 1) },
      { label: '+1 Ki Level', action: () => this.sendAdmin('ki_level', 1) },
      { label: 'Spawn NPC', action: () => this.adminSpawnNPC() },
      {
        label: targetNpc ? `Heal ${targetName}` : 'Heal NPCs',
        action: () => {
          if (targetNpc) {
            this.sendAdmin('full_hp', 0);
            return;
          }
          for (const npc of scene.npcs) {
            if (npc.isDead?.()) continue;
            scene._conn.send({ type: 'admin', field: 'full_hp', value: 0, target_npc_id: npc.id });
          }
        },
      },
      { label: 'Spawn Dummy', action: () => scene._conn.send({ type: 'build_dummy', logs: 20 }) },
      { label: 'Place Anvil', action: () => scene._placeAnvil() },
    ];
    const panelW = 240;
    const page2Rows = 2 + IMPLEMENTED_KI_MOVES.length;
    const panelH = 38 + (page === 1 ? items.length : page2Rows) * 32 + 8;
    const px = W / 2 - panelW / 2;
    const py = H / 2 - panelH / 2;
    const els = [];

    const bg = scene.addHud(scene.add.rectangle(px, py, panelW, panelH, 0x111122, 0.95)
      .setDepth(60).setOrigin(0, 0));
    els.push(bg);
    const title = scene.addHud(scene.add.text(px + panelW / 2, py + 12, `ADMIN P${page}  [Q close, ←/→ page]`, {
      fontSize: '13px', color: '#ffcc44',
    }).setDepth(61).setOrigin(0.5, 0));
    els.push(title);

    const btnH = 28;
    const btnW = panelW - 24;
    const addActionButton = (by, label, action) => {
      const btn = scene.addHud(scene.add.rectangle(px + 12, by, btnW, btnH, 0x223344, 1)
        .setDepth(61).setOrigin(0, 0).setInteractive({ useHandCursor: true }));
      const lbl = scene.addHud(scene.add.text(px + 12 + btnW / 2, by + btnH / 2, label, {
        fontSize: '13px', color: '#ccddff',
      }).setDepth(62).setOrigin(0.5, 0.5));
      btn.on('pointerover', () => { btn.setFillStyle(0x335566); lbl.setColor('#ffffff'); });
      btn.on('pointerout', () => { btn.setFillStyle(0x223344); lbl.setColor('#ccddff'); });
      btn.on('pointerdown', action);
      els.push(btn, lbl);
    };

    if (page === 1) {
      items.forEach((item, i) => addActionButton(py + 38 + i * (btnH + 4), item.label, item.action));
    } else {
      let row = 0;
      const addLabel = (text, color = '#ccddff') => {
        const by = py + 38 + row * (btnH + 4);
        const lbl = scene.addHud(scene.add.text(px + 14, by + btnH / 2, text, {
          fontSize: '13px', color,
        }).setDepth(62).setOrigin(0, 0.5));
        els.push(lbl);
        row += 1;
        return by;
      };
      const addMiniButton = (x, y, label, action, width = 28) => {
        const btn = scene.addHud(scene.add.rectangle(x, y, width, 24, 0x223344, 1)
          .setDepth(61).setOrigin(0, 0).setInteractive({ useHandCursor: true }));
        const txt = scene.addHud(scene.add.text(x + width / 2, y + 12, label, {
          fontSize: '12px', color: '#ccddff',
        }).setDepth(62).setOrigin(0.5));
        btn.on('pointerover', () => { btn.setFillStyle(0x335566); txt.setColor('#ffffff'); });
        btn.on('pointerout', () => { btn.setFillStyle(0x223344); txt.setColor('#ccddff'); });
        btn.on('pointerdown', action);
        els.push(btn, txt);
      };

      addLabel(`${targetName} Ki Admin`, '#ffffff');
      addLabel(`Learned Moves: ${(actor?.kiMoves || []).length}`, '#7799aa');
      for (const move of IMPLEMENTED_KI_MOVES) {
        const by = py + 38 + row * (btnH + 4);
        const learned = (actor?.kiMoves || []).includes(move.id);
        const lbl = scene.addHud(scene.add.text(px + 14, by + btnH / 2, move.label, {
          fontSize: '13px', color: learned ? '#99ffff' : '#ccddff',
        }).setDepth(62).setOrigin(0, 0.5));
        els.push(lbl);
        addMiniButton(px + panelW - 86, by + 2, learned ? 'Unlearn' : 'Learn', () => {
          // Optimistic local update so UI reflects immediately
          if (!actor.kiMoves) actor.kiMoves = [];
          if (actor.kiMoves.includes(move.id)) {
            actor.kiMoves = actor.kiMoves.filter(m => m !== move.id);
          } else {
            actor.kiMoves.push(move.id);
          }
          this.sendAdmin('ki_move_toggle', 0, { move_id: move.id });
          this.renderAdminPanel();
        }, 72);
        row += 1;
      }
    }
    scene._adminPanel = els;
  }

  closeAdmin() {
    this.scene._adminOpen = false;
    if (this.scene._adminPanel) {
      for (const el of this.scene._adminPanel) {
        this.scene.removeHud(el);
        el.destroy();
      }
      this.scene._adminPanel = null;
    }
  }

  adminSpawnNPC() {
    const scene = this.scene;
    const pos = tilePos(
      Math.floor(scene.player.x / TILE_SIZE) + 1,
      Math.floor(scene.player.y / TILE_SIZE),
    );
    const npc = new NPC(scene, pos.x, pos.y, undefined, scene.playerId);
    scene.npcs.push(npc);
    const runner = new NPCTaskRunner(scene, npc);
    scene._taskRunners.set(npc.id, runner);
    scene._npcBrains.set(npc.id, new NPCBrain(scene, npc, runner));
    scene._selectNPC(npc);
    scene._conn.send({ type: 'register_npc', npc_id: npc.id });
    npc.showBubble('Admin spawned me!', 3000);
  }
}
