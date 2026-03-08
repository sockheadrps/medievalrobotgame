// NPCHUDPanel
// Context tab that switches HUD data sources from player -> selected NPC.

export class NPCHUDPanel {
  constructor(scene, hud, getSelectedNPC, skillsPanel, playerInventory, playerSkills) {
    this._scene = scene;
    this._hud = hud;
    this._getSelectedNPC = getSelectedNPC;
    this._skillsPanel = skillsPanel;
    this._playerInventory = playerInventory;
    this._playerSkills = playerSkills;
    this._visible = false;
  }

  show() {
    const npc = this._getSelectedNPC?.();
    if (!npc) {
      this.hide();
      return;
    }
    this._visible = true;
    this._hud.setDataSources({
      inventory: npc.getInventoryData(),
      skillSystem: npc.skills,
    });
    this._skillsPanel.setSkillSystem(npc.skills);
    this._skillsPanel.setInventory(npc.getInventoryData());
  }

  hide() {
    this._visible = false;
  }

  isOpen() {
    return this._visible;
  }
}
