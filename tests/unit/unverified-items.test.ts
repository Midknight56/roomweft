import { describe, expect, it } from 'vitest';
import { unverifiedItemsText } from '../../src/client/helpers';

describe('unverified item count', () => {
  it('uses the singular form for one item', () => {
    expect(unverifiedItemsText(1)).toBe('1 item with fit unverified');
  });

  it('uses the plural form for multiple items', () => {
    expect(unverifiedItemsText(2)).toBe('2 items with fit unverified');
  });
});
