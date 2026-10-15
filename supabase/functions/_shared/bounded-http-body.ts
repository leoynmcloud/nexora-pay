/** Read a request body without buffering more than the endpoint's byte limit. */
export async function readBoundedHttpBody(request: Request, maximumBytes: number): Promise<string | null> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new RangeError('maximumBytes_invalid');
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength) || Number(declaredLength) > maximumBytes) return null;
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return null; }
}
