import { describe, expect, it } from 'vitest'
import { REDSTONE_PLACEMENT_ITEMS } from '../src/qa/redstone-placement-items.js'

describe('redstone placement QA items', () => {
  it('matches the compose QA placement set', () => {
    expect([...REDSTONE_PLACEMENT_ITEMS]).toStrictEqual([
      'redstone_dust',
      'redstone_torch',
      'lever',
      'stone_button',
      'repeater',
      'redstone_lamp',
      'observer',
      'comparator',
      'dispenser',
      'dropper',
      'hopper',
      'piston',
      'powered_rail',
      'door',
      'pressure_plate',
    ])
  })
})
