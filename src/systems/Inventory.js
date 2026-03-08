// Inventory — slot-based grid inventory with weight tracking.
//
// Internal storage: array of slots, each { itemKey, qty } or null.
// Backward-compatible API: add/get/remove/set/getAll still work identically
// for callers that don't care about slots.
//
// Events:
//   'change'         — { resource, total }  (same as before)
//   'inventory-full' — { resource, amount } (could not fit all items)

import Phaser from 'phaser';
import { ITEMS, getItem } from '../data/items.js';
import { BASE_INVENTORY_SLOTS, MAX_INVENTORY_SLOTS, BASE_CARRY_CAPACITY } from '../constants.js';

export class Inventory extends Phaser.Events.EventEmitter {
  constructor() {
    super();
    this._slots         = new Array(BASE_INVENTORY_SLOTS).fill(null);
    this._unlockedSlots = BASE_INVENTORY_SLOTS;
    this._weightCapacity = BASE_CARRY_CAPACITY;
  }

  // ── Slot queries ──────────────────────────────────────────────────────────

  getSlots()           { return this._slots; }
  getSlot(i)           { return this._slots[i] ?? null; }
  getUnlockedSlots()   { return this._unlockedSlots; }
  getWeightCapacity()  { return this._weightCapacity; }

  setWeightCapacity(cap) { this._weightCapacity = cap; }

  unlockSlots(count) {
    this._unlockedSlots = Math.min(MAX_INVENTORY_SLOTS, this._unlockedSlots + count);
    // Expand array if needed
    while (this._slots.length < this._unlockedSlots) this._slots.push(null);
  }

  isFull() {
    for (let i = 0; i < this._unlockedSlots; i++) {
      if (!this._slots[i]) return false;
    }
    return true;
  }

  /** Check if qty of resource can fit into current slots. */
  canAdd(resource, amount = 1) {
    const def = getItem(resource);
    const maxStack = def.maxStack ?? (def.stackable ? 50 : 1);
    let remaining = amount;

    // Fill existing partial stacks
    for (let i = 0; i < this._unlockedSlots; i++) {
      const s = this._slots[i];
      if (s && s.itemKey === resource && s.qty < maxStack) {
        remaining -= (maxStack - s.qty);
        if (remaining <= 0) return true;
      }
    }

    // Count empty slots
    for (let i = 0; i < this._unlockedSlots; i++) {
      if (!this._slots[i]) {
        remaining -= maxStack;
        if (remaining <= 0) return true;
      }
    }

    return remaining <= 0;
  }

  // ── Weight ────────────────────────────────────────────────────────────────

  getTotalWeight() {
    let total = 0;
    for (let i = 0; i < this._unlockedSlots; i++) {
      const s = this._slots[i];
      if (s) {
        const w = getItem(s.itemKey).weight ?? 1;
        total += w * s.qty;
      }
    }
    return total;
  }

  // ── Backward-compatible API ───────────────────────────────────────────────

  /** Add items, filling partial stacks first then empty slots. Returns amount actually added. */
  add(resource, amount = 1) {
    const def = getItem(resource);
    const maxStack = def.maxStack ?? (def.stackable ? 50 : 1);
    let remaining = amount;

    // 1. Fill existing partial stacks
    for (let i = 0; i < this._unlockedSlots && remaining > 0; i++) {
      const s = this._slots[i];
      if (s && s.itemKey === resource && s.qty < maxStack) {
        const space = maxStack - s.qty;
        const toAdd = Math.min(space, remaining);
        s.qty += toAdd;
        remaining -= toAdd;
      }
    }

    // 2. Fill empty slots
    for (let i = 0; i < this._unlockedSlots && remaining > 0; i++) {
      if (!this._slots[i]) {
        const toAdd = Math.min(maxStack, remaining);
        this._slots[i] = { itemKey: resource, qty: toAdd };
        remaining -= toAdd;
      }
    }

    const added = amount - remaining;
    if (added > 0) {
      this.emit('change', { resource, total: this.get(resource) });
    }
    if (remaining > 0) {
      this.emit('inventory-full', { resource, amount: remaining });
    }
    return added;
  }

  /** Get total quantity of a resource across all slots. */
  get(resource) {
    let total = 0;
    for (let i = 0; i < this._unlockedSlots; i++) {
      const s = this._slots[i];
      if (s && s.itemKey === resource) total += s.qty;
    }
    return total;
  }

  /** Remove qty from slots holding this resource (last-to-first). Returns amount removed. */
  remove(resource, amount = 1) {
    let remaining = amount;

    // Remove from last slot first so earlier slots stay populated
    for (let i = this._unlockedSlots - 1; i >= 0 && remaining > 0; i--) {
      const s = this._slots[i];
      if (s && s.itemKey === resource) {
        const toRemove = Math.min(s.qty, remaining);
        s.qty -= toRemove;
        remaining -= toRemove;
        if (s.qty <= 0) this._slots[i] = null;
      }
    }

    const removed = amount - remaining;
    if (removed > 0) {
      this.emit('change', { resource, total: this.get(resource) });
    }
    return removed;
  }

  /** Set total quantity — shim that computes delta and calls add/remove. */
  set(resource, amount) {
    const current = this.get(resource);
    const target  = Math.max(0, amount);
    if (target > current) {
      this.add(resource, target - current);
    } else if (target < current) {
      this.remove(resource, current - target);
    }
  }

  /** Returns { key: totalQty } for all resources with qty > 0. */
  getAll() {
    const result = {};
    for (let i = 0; i < this._unlockedSlots; i++) {
      const s = this._slots[i];
      if (s) {
        result[s.itemKey] = (result[s.itemKey] ?? 0) + s.qty;
      }
    }
    return result;
  }

  // ── Slot manipulation ─────────────────────────────────────────────────────

  swapSlots(i, j) {
    if (i < 0 || i >= this._unlockedSlots || j < 0 || j >= this._unlockedSlots) return;
    const tmp = this._slots[i];
    this._slots[i] = this._slots[j];
    this._slots[j] = tmp;
    this.emit('change', { resource: null, total: 0 });
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  serialise() {
    return {
      slots: this._slots.slice(0, this._unlockedSlots).map(s => s ? { ...s } : null),
      unlockedSlots: this._unlockedSlots,
      weightCapacity: this._weightCapacity,
    };
  }

  /** Load from saved data. Handles both old format ({ Wood: 5 }) and new slot format. */
  deserialise(data) {
    if (!data) return;

    // New slot-based format
    if (data.slots) {
      this._unlockedSlots = data.unlockedSlots ?? BASE_INVENTORY_SLOTS;
      this._weightCapacity = data.weightCapacity ?? BASE_CARRY_CAPACITY;
      // Ensure array is big enough
      while (this._slots.length < this._unlockedSlots) this._slots.push(null);
      for (let i = 0; i < this._unlockedSlots; i++) {
        this._slots[i] = data.slots[i] ? { ...data.slots[i] } : null;
      }
      // Clear any extra slots beyond unlocked count
      for (let i = this._unlockedSlots; i < this._slots.length; i++) {
        this._slots[i] = null;
      }
      this.emit('change', { resource: null, total: 0 });
      return;
    }

    // Old format migration: plain { Wood: 50, Stone: 20 } object
    // Clear all slots first
    for (let i = 0; i < this._slots.length; i++) this._slots[i] = null;
    this._unlockedSlots = BASE_INVENTORY_SLOTS;
    this._weightCapacity = BASE_CARRY_CAPACITY;

    for (const [key, qty] of Object.entries(data)) {
      if (typeof qty === 'number' && qty > 0) {
        this.add(key, qty);
      }
    }
    this.emit('change', { resource: null, total: 0 });
  }
}
