import Phaser from 'phaser';

export class SelectionController {
  constructor(scene) {
    this.scene = scene;
  }

  buildTabCycleList() {
    const scene = this.scene;
    const px = scene.player?.x ?? 0;
    const py = scene.player?.y ?? 0;
    const distToPlayer = (entity) => Phaser.Math.Distance.Between(px, py, entity.x, entity.y);

    const own = (scene.npcs || [])
      .filter(n => !n.isDead?.() && !n.isKnockedOut?.())
      .map(entity => ({ kind: 'own_npc', entity, distance: distToPlayer(entity) }))
      .sort((a, b) => a.distance - b.distance);

    const remotePlayers = Object.values(scene._remotePlayers || {})
      .filter(p => !p.isDead?.() && !p.isKnockedOut?.())
      .map(entity => ({ kind: 'remote_player', entity, distance: distToPlayer(entity) }));

    const remoteNpcs = Object.values(scene._remoteNPCSprites || {})
      .filter(n => !n.isDead?.() && !n.isKnockedOut?.())
      .map(entity => ({ kind: 'remote_npc', entity, distance: distToPlayer(entity) }));

    const remote = [...remotePlayers, ...remoteNpcs]
      .sort((a, b) => a.distance - b.distance);

    return [...own, ...remote];
  }

  clearSelection() {
    const scene = this.scene;
    if (scene.selectedNPC) scene.selectedNPC.deselect();
    if (scene._focusedRemote?.setSelected) scene._focusedRemote.setSelected(false);
    scene.selectedNPC = null;
    scene._focusedRemote = null;
    scene._hideNPCPanel();
    scene._driveIndicator?.detach();
  }

  selectNPC(npc) {
    const scene = this.scene;
    if (scene.selectedNPC === npc && !scene._focusedRemote) return;
    this.clearSelection();
    scene.selectedNPC = npc;
    if (npc) npc.select();
    if (npc) scene._driveIndicator?.attach(npc);
  }

  selectRemote(entity) {
    const scene = this.scene;
    if (scene._focusedRemote === entity && !scene.selectedNPC) return;
    this.clearSelection();
    scene._focusedRemote = entity;
    entity?.setSelected?.(true);
  }

  handleOwnNPCPointerDown(npc, pointer) {
    const scene = this.scene;
    const isRightClick = pointer.rightButtonDown() || pointer.button === 2;
    if (isRightClick) {
      this.selectNPC(npc);
      scene._openContextMenu(npc, pointer);
      return;
    }

    scene._closeContextMenu();
    if (scene._armedAction) this.disarmActionMode();
    this.selectNPC(npc);
  }

  handleRemoteEntityPointerDown(entity, pointer, event) {
    const scene = this.scene;
    event?.stopPropagation?.();
    if (pointer._fgHandled) return;
    const isRightClick = pointer.rightButtonDown() || pointer.button === 2;
    if (isRightClick) {
      this.selectRemote(entity);
      scene._openContextMenu(entity, pointer);
      pointer._fgHandled = true;
      return;
    }

    scene._closeContextMenu();

    if (scene._armedAction === 'attack') {
      pointer._fgHandled = true;
      if (this.isAttackableEntity(entity)) this.executeAttack(entity);
      return;
    }

    this.selectRemote(entity);
  }

  isAttackableEntity(entity) {
    if (!entity || entity.isDead?.() || entity.isKnockedOut?.()) return false;
    return !!(entity.playerId || entity.ownerPid);
  }

  executeAttack(entity) {
    const scene = this.scene;
    if (scene._playerKnockedOut || !this.isAttackableEntity(entity)) return;
    entity._onAttackClicked?.();
  }

  armActionMode(action) {
    const scene = this.scene;
    scene._armedAction = action;
    scene._closeContextMenu();
  }

  disarmActionMode() {
    this.scene._armedAction = null;
  }

  refreshAttackIndicators() {
    const scene = this.scene;
    const armed = scene._armedAction === 'attack';
    for (const rp of Object.values(scene._remotePlayers || {})) {
      rp.setAttackable?.(armed && !rp.isDead?.());
    }
    for (const rnpc of Object.values(scene._remoteNPCSprites || {})) {
      rnpc.setAttackable?.(armed && !rnpc.isDead?.());
    }
  }

  updateArmedStatus() {
    const scene = this.scene;
    if (scene._taskRecorder?.isRecording()) {
      const name = scene._taskRecorder.getTaskName();
      scene._armedStatus.setText(`Recording Task "${name}" — click ore nodes & crates, then /save_task`).setVisible(true);
    } else if (scene._armedAction === 'attack') {
      scene._armedStatus.setText('Attack Mode - left click a red target, Esc to cancel').setVisible(true);
    } else if (scene._armedAction === 'plant_seed') {
      scene._armedStatus.setText('Plant Mode — click a fertile soil tile, Esc to cancel').setVisible(true);
    } else {
      scene._armedStatus.setVisible(false);
    }
  }
}
