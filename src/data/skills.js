// skills.js — All skill and recipe definitions.
// Imported by SkillSystem and SkillsPanel.
//
// Each skill:  { id, name, color, recipes[] }
// Each recipe: { id, label, inputs, output, craftMs, xpPerCraft, levelRequired }
// Skills with empty recipes[] show level/XP but have no manual crafting UI.
//
// XP sources not tied to recipes are noted in comments and wired in entity files.

export const SKILL_DEFS = [

  // ── Gathering ─────────────────────────────────────────────────────────────

  {
    id: 'woodcutting', name: 'Woodcutting', color: '#88ff88',
    recipes: [],
    // XP: 25 per tree chop (Tree.js, NPCTaskRunner.js)
  },
  {
    id: 'mining', name: 'Mining', color: '#aaaaff',
    recipes: [],
    // XP: 10 per ore (Quarry.js), 15 per iron crush (OreCrusher.js)
  },

  // ── Production ────────────────────────────────────────────────────────────

  {
    id: 'smithing', name: 'Smithing', color: '#ffcc66',
    recipes: [
      // Ammunition
      {
        id: 'smith_arrowhead', label: 'Iron Arrowheads (×3)',
        inputs:  [{ item: 'IronBar', qty: 1 }],
        output:  { item: 'IronArrowhead', qty: 3 },
        craftMs: 1000, xpPerCraft: 15, levelRequired: 1,
      },
      // Iron nails (building material)
      {
        id: 'smith_iron_nails', label: 'Iron Nails (×20)',
        inputs:  [{ item: 'IronBar', qty: 2 }],
        output:  { item: 'IronNail', qty: 20 },
        craftMs: 1500, xpPerCraft: 20, levelRequired: 5,
      },
      // Bronze weapons (Smithing 1–3, needs CopperBar future ore)
      {
        id: 'smith_bronze_sword', label: 'Bronze Sword',
        inputs:  [{ item: 'CopperBar', qty: 2 }],
        output:  { item: 'BronzeSword', qty: 1 },
        craftMs: 3000, xpPerCraft: 25, levelRequired: 1,
      },
      {
        id: 'smith_bronze_shield', label: 'Bronze Shield',
        inputs:  [{ item: 'CopperBar', qty: 2 }],
        output:  { item: 'BronzeShield', qty: 1 },
        craftMs: 3000, xpPerCraft: 20, levelRequired: 1,
      },
      {
        id: 'smith_bronze_helmet', label: 'Bronze Helmet',
        inputs:  [{ item: 'CopperBar', qty: 2 }],
        output:  { item: 'BronzeHelmet', qty: 1 },
        craftMs: 3000, xpPerCraft: 22, levelRequired: 1,
      },
      {
        id: 'smith_bronze_chest', label: 'Bronze Chestplate',
        inputs:  [{ item: 'CopperBar', qty: 4 }],
        output:  { item: 'BronzeChest', qty: 1 },
        craftMs: 5000, xpPerCraft: 40, levelRequired: 3,
      },
      {
        id: 'smith_bronze_legs', label: 'Bronze Legs',
        inputs:  [{ item: 'CopperBar', qty: 3 }],
        output:  { item: 'BronzeLegs', qty: 1 },
        craftMs: 4000, xpPerCraft: 32, levelRequired: 2,
      },
      // Iron dagger (Smithing 5)
      {
        id: 'smith_iron_dagger', label: 'Iron Dagger',
        inputs:  [{ item: 'IronBar', qty: 1 }],
        output:  { item: 'IronDagger', qty: 1 },
        craftMs: 2000, xpPerCraft: 30, levelRequired: 5,
      },
      // Iron weapons & armor (Smithing 10–20)
      {
        id: 'smith_iron_sword', label: 'Iron Sword',
        inputs:  [{ item: 'IronBar', qty: 2 }],
        output:  { item: 'IronSword', qty: 1 },
        craftMs: 4000, xpPerCraft: 50, levelRequired: 10,
      },
      {
        id: 'smith_iron_spear', label: 'Iron Spear',
        inputs:  [{ item: 'IronBar', qty: 2 }],
        output:  { item: 'IronSpear', qty: 1 },
        craftMs: 4000, xpPerCraft: 45, levelRequired: 12,
      },
      {
        id: 'smith_iron_shield', label: 'Iron Shield',
        inputs:  [{ item: 'IronBar', qty: 2 }],
        output:  { item: 'IronShield', qty: 1 },
        craftMs: 3500, xpPerCraft: 40, levelRequired: 15,
      },
      {
        id: 'smith_iron_helmet', label: 'Iron Helmet',
        inputs:  [{ item: 'IronBar', qty: 2 }],
        output:  { item: 'IronHelmet', qty: 1 },
        craftMs: 3500, xpPerCraft: 42, levelRequired: 15,
      },
      {
        id: 'smith_iron_chest', label: 'Iron Chestplate',
        inputs:  [{ item: 'IronBar', qty: 4 }],
        output:  { item: 'IronChest', qty: 1 },
        craftMs: 6000, xpPerCraft: 75, levelRequired: 20,
      },
      {
        id: 'smith_iron_legs', label: 'Iron Legs',
        inputs:  [{ item: 'IronBar', qty: 3 }],
        output:  { item: 'IronLegs', qty: 1 },
        craftMs: 5000, xpPerCraft: 60, levelRequired: 18,
      },
      // Steel weapons & armor (Smithing 30–40)
      {
        id: 'smith_steel_sword', label: 'Steel Sword',
        inputs:  [{ item: 'SteelBar', qty: 2 }],
        output:  { item: 'SteelSword', qty: 1 },
        craftMs: 5000, xpPerCraft: 90, levelRequired: 30,
      },
      {
        id: 'smith_steel_shield', label: 'Steel Shield',
        inputs:  [{ item: 'SteelBar', qty: 2 }],
        output:  { item: 'SteelShield', qty: 1 },
        craftMs: 4500, xpPerCraft: 80, levelRequired: 30,
      },
      {
        id: 'smith_steel_helmet', label: 'Steel Helmet',
        inputs:  [{ item: 'SteelBar', qty: 2 }],
        output:  { item: 'SteelHelmet', qty: 1 },
        craftMs: 4500, xpPerCraft: 85, levelRequired: 30,
      },
      {
        id: 'smith_steel_chest', label: 'Steel Chestplate',
        inputs:  [{ item: 'SteelBar', qty: 5 }],
        output:  { item: 'SteelChest', qty: 1 },
        craftMs: 8000, xpPerCraft: 140, levelRequired: 40,
      },
      {
        id: 'smith_steel_legs', label: 'Steel Legs',
        inputs:  [{ item: 'SteelBar', qty: 3 }],
        output:  { item: 'SteelLegs', qty: 1 },
        craftMs: 6000, xpPerCraft: 110, levelRequired: 35,
      },
    ],
  },

  {
    id: 'fletching', name: 'Fletching', color: '#88ddff',
    recipes: [
      {
        id: 'fletch_arrow', label: 'Arrow',
        inputs:  [
          { item: 'Wood',          qty: 1 },
          { item: 'Feather',       qty: 2 },
          { item: 'IronArrowhead', qty: 1 },
        ],
        output:  { item: 'Arrow', qty: 1 },
        craftMs: 500, xpPerCraft: 10, levelRequired: 1,
      },
    ],
  },
  {
    id: 'crafting', name: 'Crafting', color: '#d8b073',
    recipes: [
      {
        id: 'craft_wooden_flywheel', label: 'Wooden Flywheel',
        inputs: [{ item: 'Wood', qty: 100 }],
        output: { item: 'WoodenFlywheel', qty: 1 },
        craftMs: 6000, xpPerCraft: 900, levelRequired: 1,
      },
      {
        id: 'craft_wood_robot_chasis_pod', label: 'Wood Robot Chasis Pod',
        inputs: [{ item: 'Wood', qty: 50 }],
        output: { item: 'WoodRobotChasisPod', qty: 1 },
        craftMs: 5000, xpPerCraft: 35, levelRequired: 1,
      },
      {
        id: 'craft_wood_wall', label: 'Wood Wall',
        inputs: [{ item: 'Wood', qty: 10 }],
        output: { item: 'WoodWall', qty: 1 },
        craftMs: 2500, xpPerCraft: 12, levelRequired: 1,
      },
      {
        id: 'craft_wood_storage', label: 'Wood Storage',
        inputs: [{ item: 'Wood', qty: 25 }],
        output: { item: 'WoodStorage', qty: 1 },
        craftMs: 4000, xpPerCraft: 25, levelRequired: 3,
      },
      {
        id: 'craft_wood_crafting_table', label: 'Wood Crafting Table',
        inputs: [{ item: 'Wood', qty: 35 }],
        output: { item: 'WoodCraftingTable', qty: 1 },
        craftMs: 5000, xpPerCraft: 35, levelRequired: 5,
      },
    ],
  },

  // ── Combat skills (XP from external actions) ──────────────────────────────

  {
    id: 'attack', name: 'Attack', color: '#ff6644',
    recipes: [],
    // XP: per melee hit landed. Effect: increases hit accuracy.
  },
  {
    id: 'strength', name: 'Strength', color: '#ff4444',
    recipes: [],
    // XP: per melee hit landed. Effect: increases melee damage.
    // Carry capacity bonus: +1 per 10 levels.
  },
  {
    id: 'defence', name: 'Defence', color: '#6688ff',
    recipes: [],
    // XP: when taking damage in combat. Effect: reduces damage taken.
    // Formula: damage = base * (1 - defenceBonus/200), capped at 75% reduction.
  },
  {
    id: 'archery', name: 'Archery', color: '#ffdd44',
    recipes: [],
    // XP: 15 per bow hit (ArrowProjectile.js). Effect: arrow damage + accuracy.
  },
  {
    id: 'constitution', name: 'Constitution', color: '#ff88aa',
    recipes: [],
    // XP: passive, from any combat action (hit or be hit).
    // Effect: maxHP = 10 + (level * 5). Lvl 1 = 15HP, Lvl 10 = 60HP.
    // HP regen: 1 HP / 30s out of combat, 1 HP / 5s in combat.
  },

  // ── Utility skills ────────────────────────────────────────────────────────

  {
    id: 'athletics', name: 'Athletics', color: '#44ddaa',
    recipes: [],
    // XP: earned by moving while carrying weight (every 5 s of movement).
    // Effect: +2 carry capacity per level. Reduces encumbrance speed penalty.
  },
];
