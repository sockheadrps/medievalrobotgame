// robotProfiles.js
// Centralized robot/NPC base stats and visuals.

export const ROBOT_PROFILES = {
  standard: {
    id: 'iron_robot',
    label: 'Iron Robot',
    baseSpeed: 100,
    maxHp: 15,
    carryCapacity: 10,
    taskEfficiency: 1.0,
    combatEnabled: true,
    speedBonuses: [1.0, 1.2, 1.4],
    bodyTint: 0x88ccff,
    nameColor: '#88ccff',
    linkColor: 0x88ccff,
  },
  wood_robot: {
    id: 'wood_robot',
    label: 'Wood Robot',
    baseSpeed: 84,
    maxHp: 10,
    carryCapacity: 8,
    taskEfficiency: 1.1,
    combatEnabled: false,
    speedBonuses: [1.0, 1.15, 1.3],
    bodyTint: 0xc99a62,
    nameColor: '#f2cf9d',
    linkColor: 0xd7ad7a,
  },
  rival: {
    id: 'rival',
    label: 'Rival',
    baseSpeed: 110,
    maxHp: 12,
    carryCapacity: 6,
    taskEfficiency: 1.0,
    combatEnabled: true,
    speedBonuses: [1.0, 1.2, 1.4],
    bodyTint:  0xff6644,
    nameColor: '#ff9977',
    linkColor: 0xff7755,
  },
};

export function getRobotProfile(profileId = 'standard') {
  return ROBOT_PROFILES[profileId] ?? ROBOT_PROFILES.standard;
}

