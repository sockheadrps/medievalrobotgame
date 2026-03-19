// TaskRecorder — records custom NPC tasks by letting the player click
// world objects (ore nodes) and storage crates to define a mine-and-deposit loop.
//
// Usage:
//   recorder.startRecording('mine_and_deposit')
//   → player clicks ore nodes and crates in the world
//   recorder.saveRecording()  → persists to localStorage
//   recorder.cancelRecording()
//
// Saved tasks can be loaded and assigned to NPCs via NPCTaskRunner.

import Phaser from 'phaser';
import { TILE_SIZE } from '../constants.js';

const STORAGE_KEY = 'fg_custom_tasks';

export class TaskRecorder {
  constructor(scene) {
    this._scene = scene;
    this._recording = false;
    this._taskName = '';
    this._oreTargets = [];    // [{ wo_id, asset_id, label, x, y }]
    this._crateTargets = [];  // [{ building_id, label, x, y }]
    this._markers = [];       // Phaser graphics for visual feedback
  }

  isRecording() { return this._recording; }
  getTaskName() { return this._taskName; }

  startRecording(name) {
    if (this._recording) return false;
    this._taskName = name.toLowerCase().replace(/\s+/g, '_');
    this._recording = true;
    this._oreTargets = [];
    this._crateTargets = [];
    this._markers = [];
    return true;
  }

  /** Try to add a clicked world object (ore node) to the recording. Returns true if added. */
  addOreTarget(worldObj) {
    if (!this._recording || !worldObj) return false;
    const woId = worldObj._woId || worldObj.woId;
    const assetId = worldObj._assetId || '';
    if (!assetId) return false;
    // Don't add duplicates by asset_id
    if (this._oreTargets.some(t => t.asset_id === assetId)) return false;
    this._oreTargets.push({
      wo_id: woId,
      asset_id: assetId,
      label: worldObj.assetDef?.label ?? assetId,
      x: worldObj.x,
      y: worldObj.y,
    });
    this._addMarker(worldObj.x, worldObj.y, 0x44ff44, 'ORE');
    return true;
  }

  /** Try to add a clicked crate to the recording. Returns true if added. */
  addCrateTarget(crate) {
    if (!this._recording || !crate) return false;
    const bid = crate._serverId;
    if (!bid) return false;
    // Don't add duplicates by building_id
    if (this._crateTargets.some(t => t.building_id === bid)) return false;
    this._crateTargets.push({
      building_id: bid,
      label: crate.getLabel?.() || '',
      x: crate.x,
      y: crate.y,
    });
    this._addMarker(crate.x, crate.y, 0x4488ff, 'CRATE');
    return true;
  }

  _addMarker(x, y, color, text) {
    const scene = this._scene;
    if (!scene) return;
    const gfx = scene.add.graphics().setDepth(10);
    gfx.lineStyle(2, color, 0.9);
    gfx.strokeCircle(x, y, TILE_SIZE * 0.7);
    const label = scene.add.text(x, y - TILE_SIZE * 0.9, text, {
      fontSize: '10px', color: `#${color.toString(16).padStart(6, '0')}`,
      backgroundColor: '#000000aa', padding: { x: 3, y: 2 },
    }).setOrigin(0.5, 1).setDepth(10);
    this._markers.push(gfx, label);
  }

  _clearMarkers() {
    for (const m of this._markers) m.destroy();
    this._markers = [];
  }

  /** Finalize recording and persist. Returns the saved task definition or null on error. */
  saveRecording() {
    if (!this._recording) return null;
    if (this._oreTargets.length === 0) return null;

    const taskDef = {
      name: this._taskName,
      ore_asset_ids: this._oreTargets.map(t => t.asset_id),
      crate_building_ids: this._crateTargets.map(t => t.building_id),
      crate_labels: this._crateTargets.map(t => t.label),
      ore_labels: this._oreTargets.map(t => t.label),
    };

    // Save to localStorage
    const all = this._loadAll();
    all[taskDef.name] = taskDef;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));

    this._recording = false;
    this._clearMarkers();
    return taskDef;
  }

  cancelRecording() {
    this._recording = false;
    this._taskName = '';
    this._oreTargets = [];
    this._crateTargets = [];
    this._clearMarkers();
  }

  /** Get a saved task definition by name. */
  getTask(name) {
    const key = name.toLowerCase().replace(/\s+/g, '_');
    return this._loadAll()[key] ?? null;
  }

  /** Get all saved task names. */
  getTaskNames() {
    return Object.keys(this._loadAll());
  }

  /** Delete a saved task by name. */
  deleteTask(name) {
    const key = name.toLowerCase().replace(/\s+/g, '_');
    const all = this._loadAll();
    delete all[key];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  }

  _loadAll() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  /** Get a summary string for chat display. */
  getRecordingSummary() {
    const ores = this._oreTargets.map(t => t.label).join(', ') || 'none';
    const crates = this._crateTargets.map(t => t.label || 'unlabeled').join(', ') || 'none';
    return `Ores: ${ores} | Crates: ${crates}`;
  }
}
