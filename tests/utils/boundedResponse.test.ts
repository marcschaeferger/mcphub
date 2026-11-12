import { readResponseTextWithLimit } from '../../src/utils/boundedResponse.js';

describe('readResponseTextWithLimit', () => {
  it('returns the body when it fits', async () => {
    await expect(readResponseTextWithLimit(new Response('héllo'), 64)).resolves.toBe('héllo');
  });

  it('stops reading an endless chunked body once the limit is exceeded', async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(1024));
      },
    });

    await expect(readResponseTextWithLimit(new Response(endless), 4096)).resolves.toBeUndefined();
    expect(pulled).toBeLessThan(10);
  });

  it('counts bytes, not UTF-16 characters', async () => {
    // 3 characters, 9 bytes.
    await expect(readResponseTextWithLimit(new Response('€€€'), 8)).resolves.toBeUndefined();
  });
});
