export const KI_DENOMINATIONS = {
  utility: {
    id: 'utility',
    label: 'Utility Denomination',
    cost: 3,
    theme: 'Defense, awareness, and sustained control.',
    moves: {
      sense_ki: {
        id: 'sense_ki',
        label: 'Sense Ki',
        cost: 1,
        augments: {
          sense_1: {
            id: 'sense_1',
            label: 'Sense 1',
            kind: 'passive',
            cost: 1,
          },
          sense_2: {
            id: 'sense_2',
            label: 'Sense 2',
            kind: 'passive',
            cost: 2,
          },
          sense_3: {
            id: 'sense_3',
            label: 'Sense 3',
            kind: 'passive',
            cost: 3,
          },
          reveal_name: {
            id: 'reveal_name',
            label: 'Reveal Name',
            kind: 'passive',
            cost: 2,
          },
          clairvoyance: {
            id: 'clairvoyance',
            label: 'Clairvoyance',
            kind: 'slottable',
            slotGroup: 'sense_ki_mode',
            cost: 4,
          },
        },
      },
      charge: {
        id: 'charge',
        label: 'Charge',
        cost: 1,
        augments: {},
      },
      barrier: {
        id: 'barrier',
        label: 'Barrier',
        cost: 1,
        augments: {
          ki_guard: {
            id: 'ki_guard',
            label: 'Ki Guard',
            kind: 'passive',
            cost: 2,
          },
        },
      },
    },
  },
  offense: {
    id: 'offense',
    label: 'Offense Denomination',
    cost: 3,
    theme: 'Projectile control and shot behavior.',
    moves: {
      ki_shot: {
        id: 'ki_shot',
        label: 'Ki Shot',
        cost: 1,
        augments: {
          explosive: {
            id: 'explosive',
            label: 'Explosive',
            kind: 'slottable',
            slotGroup: 'ki_shot_mode',
            cost: 3,
          },
          homing: {
            id: 'homing',
            label: 'Homing',
            kind: 'slottable',
            slotGroup: 'ki_shot_mode',
            cost: 4,
          },
          echo_shot: {
            id: 'echo_shot',
            label: 'Echo Shot',
            kind: 'slottable',
            slotGroup: 'ki_shot_mode',
            cost: 5,
          },
        },
      },
    },
  },
};

export const LEGACY_KI_MOVE_DENOMINATION_MAP = {
  sense_ki: 'utility',
  charge: 'utility',
  barrier: 'utility',
  ki_shot: 'offense',
};
