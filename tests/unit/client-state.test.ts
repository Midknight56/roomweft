import { expect, it, vi } from 'vitest';
import { store } from '../../src/client/state';

it('keeps brief typing in state without a render, then notifies on the next action', () => {
  const listener = vi.fn(); const unsubscribe = store.subscribe(listener);
  listener.mockClear();
  try {
    store.set({brief:'Evening reading'}, false);
    expect(store.get().brief).toBe('Evening reading');
    expect(listener).not.toHaveBeenCalled();
    store.set({busy:true});
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({brief:'Evening reading',busy:true}));
  } finally { unsubscribe(); store.set({brief:undefined,busy:false}); }
});
