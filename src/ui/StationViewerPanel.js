/**
 * StationViewerPanel — right-click overlay for crafting_station buildings.
 * Shows current stored contents with deposit/withdraw buttons.
 */
export class StationViewerPanel {
  constructor(scene) {
    this._scene = scene;
    this._el = null;
    this._stationDef = null;
  }

  open(building, stationDef) {
    this.close();
    this._stationDef = stationDef;
    const stored = building.getStored ? building.getStored() : (building.stored || {});
    const bid = building._serverId || building.id;
    const label = stationDef?.label || bid;

    const panel = document.createElement('div');
    panel.id = '_stationViewerPanel';
    panel.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);background:#1a1a2e;border:2px solid #666;border-radius:8px;padding:16px;z-index:9999;min-width:280px;color:#eee;font-family:monospace;';

    let html = `<div style="font-size:15px;font-weight:bold;margin-bottom:12px;">${label}</div>`;
    html += '<div style="font-size:12px;color:#aaa;margin-bottom:8px;">Stored Contents</div>';

    const entries = Object.entries(stored);
    if (entries.length === 0) {
      html += '<div style="color:#666;font-size:12px;">Empty</div>';
    } else {
      for (const [item, qty] of entries) {
        if (qty <= 0) continue;
        html += `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;padding:4px 8px;background:#2a2a3e;border-radius:4px;">
          <span>${item}: <b>${qty}</b></span>
          <span>
            <button onclick="window._stationViewer?.withdraw('${item}',1,'${bid}')" style="background:#334;border:1px solid #556;color:#eee;padding:2px 8px;cursor:pointer;border-radius:3px;margin-right:4px;">-1</button>
            <button onclick="window._stationViewer?.deposit('${item}',1,'${bid}')" style="background:#334;border:1px solid #556;color:#eee;padding:2px 8px;cursor:pointer;border-radius:3px;">+1</button>
          </span>
        </div>`;
      }
    }

    html += `<div style="margin-top:12px;">
      <button onclick="window._stationViewer?.close()" style="background:#333;border:1px solid #555;color:#aaa;padding:6px 16px;cursor:pointer;border-radius:4px;">Close</button>
    </div>`;

    panel.innerHTML = html;
    document.body.appendChild(panel);
    this._el = panel;
    this._building = building;
    this._bid = bid;

    window._stationViewer = this;
  }

  deposit(item, qty, bid) {
    const scene = this._scene;
    const inv = scene.player?.inventory;
    if (!inv || (inv[item] || 0) < qty) return;
    inv[item] = (inv[item] || 0) - qty;
    if (inv[item] <= 0) delete inv[item];
    const stored = this._building.getStored ? this._building.getStored() : {};
    stored[item] = (stored[item] || 0) + qty;
    if (this._building.setStored) this._building.setStored(stored);
    scene._conn?.send({ type: 'update_building_stored', building_id: bid, stored });
    this.open(this._building, this._stationDef);
  }

  withdraw(item, qty, bid) {
    const scene = this._scene;
    const stored = this._building.getStored ? this._building.getStored() : {};
    if ((stored[item] || 0) < qty) return;
    stored[item] = (stored[item] || 0) - qty;
    if (stored[item] <= 0) delete stored[item];
    if (this._building.setStored) this._building.setStored(stored);
    const inv = scene.player?.inventory;
    if (!inv) return;
    inv[item] = (inv[item] || 0) + qty;
    scene._conn?.send({ type: 'update_building_stored', building_id: bid, stored });
    this.open(this._building, this._stationDef);
  }

  close() {
    this._el?.remove();
    this._el = null;
    window._stationViewer = null;
  }
}
