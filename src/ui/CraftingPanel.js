export class CraftingPanel {
  constructor(scene, inventory) {
    this._scene    = scene;
    this._visible  = false;

    const cx = scene.cameras.main.width  / 2;
    const cy = scene.cameras.main.height / 2;
    const W  = 360;
    const H  = 300;

    const bg = scene.add.rectangle(0, 0, W, H, 0x1a1a2e, 0.96)
                        .setStrokeStyle(2, 0xff8800);

    const title = scene.add.text(0, -H / 2 + 24, 'MOTHER MACHINE', {
      fontSize: '18px', color: '#ff8800', align: 'center'
    }).setOrigin(0.5);

    const subtitle = scene.add.text(0, -H / 2 + 52, 'Crafting — Phase 2', {
      fontSize: '13px', color: '#888888', align: 'center'
    }).setOrigin(0.5);

    const body = scene.add.text(0, 0,
      'Gather resources to unlock recipes.\n\nWood → Basic Drone Frame\nStone → Machine Housing\n\n(Recipes unlock in Phase 2)', {
      fontSize: '13px', color: '#cccccc', align: 'center', lineSpacing: 6
    }).setOrigin(0.5);

    const closeHint = scene.add.text(0, H / 2 - 18, 'Press E or click outside to close', {
      fontSize: '11px', color: '#555555', align: 'center'
    }).setOrigin(0.5);

    this._container = scene.add.container(cx, cy, [bg, title, subtitle, body, closeHint]);
    this._container.setScrollFactor(0);
    this._container.setDepth(20);
    this._container.setVisible(false);

    // Click outside to close
    scene.input.on('pointerdown', (pointer) => {
      if (!this._visible) return;
      const left   = cx - W / 2;
      const top    = cy - H / 2;
      if (pointer.x < left || pointer.x > left + W ||
          pointer.y < top  || pointer.y > top  + H) {
        this.hide();
      }
    });
  }

  show()   { this._container.setVisible(true);  this._visible = true;  }
  hide()   { this._container.setVisible(false); this._visible = false; }
  toggle() { this._visible ? this.hide() : this.show(); }
  isOpen() { return this._visible; }
}
