// items.js — Central registry of every item type in the game.
// Referenced by string key everywhere (inventory, recipes, drops, equipment slots).
//
// type:
//   'resource'          — raw stackable material
//   'building_material' — processed material used in construction
//   'weapon'            — equippable, occupies 'mainhand' slot
//   'armor'             — equippable, occupies head/chest/legs/offhand slot
//   'consumable'        — single-use item with an effect
//   'ammo'              — used up when firing a ranged weapon
//   'misc'              — anything else (quest items, upgrade components)
//
// Equippable items have:
//   equipSlot: 'mainhand' | 'offhand' | 'head' | 'chest' | 'legs' | 'feet' | 'ammo'
//   attackBonus:  additive bonus to attack roll
//   defenceBonus: additive damage reduction
//   strengthBonus: bonus to melee damage
//   speed:        attack interval in seconds (weapons only)
//   ranged:       true if weapon fires a projectile
//
// All items have:
//   weight:   number (kg) — used for encumbrance system
//   maxStack: number — max quantity per inventory slot (1 for non-stackable)

export const ITEMS = {

  // ── Resources (already tracked as strings; define here for UI/drops) ──────

  Wood:            { name: 'Wood',             type: 'resource',          stackable: true,  maxStack: 50,  weight: 1   },
  Stone:           { name: 'Stone',            type: 'resource',          stackable: true,  maxStack: 50,  weight: 2   },
  Ore:             { name: 'Ore',              type: 'resource',          stackable: true,  maxStack: 50,  weight: 2   },
  Iron:            { name: 'Iron',             type: 'resource',          stackable: true,  maxStack: 50,  weight: 2   },
  IronBar:         { name: 'Iron Bar',         type: 'resource',          stackable: true,  maxStack: 50,  weight: 3   },
  IronArrowhead:   { name: 'Iron Arrowhead',   type: 'resource',          stackable: true,  maxStack: 100, weight: 0.2 },
  Feather:         { name: 'Feather',          type: 'resource',          stackable: true,  maxStack: 100, weight: 0.1 },
  Arrow:           { name: 'Arrow',            type: 'ammo',              stackable: true,  maxStack: 200, weight: 0.1 },
  Coal:            { name: 'Coal',             type: 'resource',          stackable: true,  maxStack: 50,  weight: 1   },
  CopperOre:       { name: 'Copper Ore',       type: 'resource',          stackable: true,  maxStack: 50,  weight: 2   },
  CopperBar:       { name: 'Copper Bar',       type: 'resource',          stackable: true,  maxStack: 50,  weight: 3   },
  TinOre:          { name: 'Tin Ore',          type: 'resource',          stackable: true,  maxStack: 50,  weight: 2   },
  SteelBar:        { name: 'Steel Bar',        type: 'resource',          stackable: true,  maxStack: 50,  weight: 4   },
  BronzeBar:       { name: 'Bronze Bar',       type: 'resource',          stackable: true,  maxStack: 50,  weight: 3   },
  GoldOre:         { name: 'Gold Ore',         type: 'resource',          stackable: true,  maxStack: 50,  weight: 3   },
  GoldBar:         { name: 'Gold Bar',         type: 'resource',          stackable: true,  maxStack: 50,  weight: 4   },

  // ── Building Materials ────────────────────────────────────────────────────

  IronNail:        { name: 'Iron Nail',        type: 'building_material', stackable: true,  maxStack: 100, weight: 0.1 },
  WoodenFrame:     { name: 'Wooden Frame',     type: 'building_material', stackable: true,  maxStack: 20,  weight: 3,   placeable: 'wood_frame' },
  ReinforcedBlock: { name: 'Reinforced Block', type: 'building_material', stackable: true,  maxStack: 20,  weight: 5,   placeable: 'reinforced_block' },
  Door:            { name: 'Door',             type: 'building_material', stackable: true,  maxStack: 20,  weight: 4,   placeable: 'door' },
  WoodenFlywheel:  { name: 'Wooden Flywheel',  type: 'building_material', stackable: true,  maxStack: 20,  weight: 8,   placeable: 'wooden_flywheel' },
  WoodWall:        { name: 'Wood Wall',        type: 'building_material', stackable: true,  maxStack: 40,  weight: 3,   placeable: 'wood_wall' },
  WoodStorage:     { name: 'Wood Storage',     type: 'building_material', stackable: true,  maxStack: 20,  weight: 6,   placeable: 'wood_storage' },
  WoodCraftingTable:{ name:'Wood Crafting Table', type: 'building_material', stackable: true, maxStack: 10, weight: 7, placeable: 'wood_crafting_table' },
  WoodPulpConveyor:{ name: 'Wood Pulp Conveyor', type: 'building_material', stackable: true, maxStack: 100, weight: 1, placeable: 'wood_pulp_conveyor' },
  AnvilItem:       { name: 'Anvil',            type: 'building_material', stackable: true,  maxStack: 10,  weight: 12,  placeable: 'anvil' },
  WoodRobotChasisPod: { name: 'Wood Robot Chasis Pod', type: 'building_material', stackable: true, maxStack: 10, weight: 10, placeable: 'wood_robot_chasis_pod' },
  Cogwheel:        { name: 'Cogwheel',         type: 'misc',              stackable: true,  maxStack: 20,  weight: 2,
                     desc: 'Rare drop from quarries/crushers. Used in NPC upgrades.' },

  // ── Weapons ──────────────────────────────────────────────────────────────

  Fist: {
    name: 'Fist', type: 'weapon', stackable: false, maxStack: 1, weight: 0, equipSlot: 'mainhand',
    attackBonus: 0, strengthBonus: 0, speed: 1.5, ranged: false,
    desc: 'Unarmed. Low damage, slow.',
  },
  BronzeSword: {
    name: 'Bronze Sword', type: 'weapon', stackable: false, maxStack: 1, weight: 3, equipSlot: 'mainhand',
    attackBonus: 5, strengthBonus: 3, speed: 1.2, ranged: false,
    smithingLevel: 1,
    desc: 'A simple bronze blade. Reliable for early combat.',
  },
  IronDagger: {
    name: 'Iron Dagger', type: 'weapon', stackable: false, maxStack: 1, weight: 2, equipSlot: 'mainhand',
    attackBonus: 8, strengthBonus: 2, speed: 0.8, ranged: false,
    smithingLevel: 5,
    desc: 'Fast but low damage. Good for training attack.',
  },
  IronSword: {
    name: 'Iron Sword', type: 'weapon', stackable: false, maxStack: 1, weight: 4, equipSlot: 'mainhand',
    attackBonus: 12, strengthBonus: 8, speed: 1.4, ranged: false,
    smithingLevel: 10,
    desc: 'Solid iron blade. The workhorse of mid-game combat.',
  },
  IronSpear: {
    name: 'Iron Spear', type: 'weapon', stackable: false, maxStack: 1, weight: 5, equipSlot: 'mainhand',
    attackBonus: 10, strengthBonus: 6, speed: 1.8, ranged: false,
    smithingLevel: 12,
    desc: 'Longer reach, slower swing. Good against multiple enemies.',
  },
  SteelSword: {
    name: 'Steel Sword', type: 'weapon', stackable: false, maxStack: 1, weight: 5, equipSlot: 'mainhand',
    attackBonus: 24, strengthBonus: 16, speed: 1.5, ranged: false,
    smithingLevel: 30,
    desc: 'Refined steel. Noticeably sharper than iron.',
  },
  Shortbow: {
    name: 'Shortbow', type: 'weapon', stackable: false, maxStack: 1, weight: 2, equipSlot: 'mainhand',
    attackBonus: 8, strengthBonus: 0, speed: 1.2, ranged: true,
    archeryLevel: 1,
    desc: 'The current player bow. Uses Arrows.',
  },
  Longbow: {
    name: 'Longbow', type: 'weapon', stackable: false, maxStack: 1, weight: 3, equipSlot: 'mainhand',
    attackBonus: 16, strengthBonus: 0, speed: 1.6, ranged: true,
    archeryLevel: 20,
    desc: 'Greater range and power than a shortbow.',
  },

  // ── Armor ─────────────────────────────────────────────────────────────────

  // Bronze set (Smithing 1)
  BronzeHelmet:    { name: 'Bronze Helmet',    type: 'armor', stackable: false, maxStack: 1, weight: 3, equipSlot: 'head',    defenceBonus: 3,  smithingLevel: 1  },
  BronzeChest:     { name: 'Bronze Chestplate',type: 'armor', stackable: false, maxStack: 1, weight: 6, equipSlot: 'chest',   defenceBonus: 7,  smithingLevel: 3  },
  BronzeLegs:      { name: 'Bronze Legs',      type: 'armor', stackable: false, maxStack: 1, weight: 5, equipSlot: 'legs',    defenceBonus: 5,  smithingLevel: 2  },
  BronzeShield:    { name: 'Bronze Shield',    type: 'armor', stackable: false, maxStack: 1, weight: 4, equipSlot: 'offhand', defenceBonus: 6,  smithingLevel: 1  },

  // Iron set (Smithing 15–20)
  IronHelmet:      { name: 'Iron Helmet',      type: 'armor', stackable: false, maxStack: 1, weight: 4, equipSlot: 'head',    defenceBonus: 5,  smithingLevel: 15 },
  IronChest:       { name: 'Iron Chestplate',  type: 'armor', stackable: false, maxStack: 1, weight: 8, equipSlot: 'chest',   defenceBonus: 12, smithingLevel: 20 },
  IronLegs:        { name: 'Iron Legs',        type: 'armor', stackable: false, maxStack: 1, weight: 6, equipSlot: 'legs',    defenceBonus: 9,  smithingLevel: 18 },
  IronShield:      { name: 'Iron Shield',      type: 'armor', stackable: false, maxStack: 1, weight: 5, equipSlot: 'offhand', defenceBonus: 8,  smithingLevel: 15 },

  // Steel set (Smithing 30–40)
  SteelHelmet:     { name: 'Steel Helmet',     type: 'armor', stackable: false, maxStack: 1, weight: 5,  equipSlot: 'head',    defenceBonus: 10, smithingLevel: 30 },
  SteelChest:      { name: 'Steel Chestplate', type: 'armor', stackable: false, maxStack: 1, weight: 10, equipSlot: 'chest',   defenceBonus: 22, smithingLevel: 40 },
  SteelLegs:       { name: 'Steel Legs',       type: 'armor', stackable: false, maxStack: 1, weight: 8,  equipSlot: 'legs',    defenceBonus: 16, smithingLevel: 35 },
  SteelShield:     { name: 'Steel Shield',     type: 'armor', stackable: false, maxStack: 1, weight: 6,  equipSlot: 'offhand', defenceBonus: 14, smithingLevel: 30 },

  // ── Consumables ───────────────────────────────────────────────────────────

  HealingPotion: {
    name: 'Healing Potion', type: 'consumable', stackable: true, maxStack: 20, weight: 0.5, equipSlot: null,
    effect: 'heal', value: 20,
    desc: 'Instantly restores 20 HP.',
  },
};

/** Returns the ITEMS entry for a key, or a fallback stub if unknown. */
export function getItem(key) {
  return ITEMS[key] ?? { name: key, type: 'resource', stackable: true, maxStack: 50, weight: 1 };
}

/** Returns true if the item is equippable (has an equipSlot). */
export function isEquippable(key) {
  return !!(ITEMS[key]?.equipSlot);
}

/** Returns true if the item is a weapon. */
export function isWeapon(key) {
  return ITEMS[key]?.type === 'weapon';
}

/** Returns true if the item is armor. */
export function isArmor(key) {
  return ITEMS[key]?.type === 'armor';
}
