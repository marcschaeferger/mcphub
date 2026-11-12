/**
 * Read a fetch Response body as UTF-8 text, aborting once more than `maxBytes`
 * arrive. Content-Length is optional (chunked encoding), so the limit has to be
 * enforced while streaming; `response.text()`/`arrayBuffer()` would buffer an
 * attacker-controlled body of any size first. Returns undefined when the body
 * exceeds the limit.
 */
export const readResponseTextWithLimit = async (
  response: Response,
  maxBytes: number,
): Promise<string | undefined> => {
  if (!response.body || typeof response.body.getReader !== 'function') {
    // Non-streaming Response implementations: best effort, check after reading.
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? undefined : Buffer.from(bytes).toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};
