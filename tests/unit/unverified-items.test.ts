import { describe, expect, it } from 'vitest';
import { unverifiedItemsText } from '../../src/client/helpers';
import { unverifiedPassMessage } from '../../src/shared/fit';

describe('unverified item count', () => {
  it('uses the singular form for one item', () => {
    expect(unverifiedItemsText(1)).toBe('1 item with fit unverified');
  });

  it('uses the plural form for multiple items', () => {
    expect(unverifiedItemsText(2)).toBe('2 items with fit unverified');
  });
});

describe('unverified pass message', () => {
  it('uses the singular word for one unverified item', () => {
    expect(unverifiedPassMessage(1)).toBe('Checks pass for sized items. One item is unverified.');
  });

  it('uses the plural count for multiple unverified items', () => {
    expect(unverifiedPassMessage(2)).toBe('Checks pass for sized items. 2 items are unverified.');
    expect(unverifiedPassMessage(3)).toBe('Checks pass for sized items. 3 items are unverified.');
  });
});
