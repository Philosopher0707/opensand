/**
 * Parses Server-Sent Events (SSE) from a raw byte stream.
 */
export async function* parseSSEStream(
  stream: AsyncIterable<Uint8Array>
): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(":")) {
        // Comment or empty heartbeat line
        continue;
      }

      if (trimmed.startsWith("data:")) {
        const payload = trimmed.slice(5).trim();
        if (payload) {
          yield payload;
        }
      }
    }
  }

  // Flush remaining buffer
  if (buffer.trim().startsWith("data:")) {
    const payload = buffer.trim().slice(5).trim();
    if (payload) {
      yield payload;
    }
  }
}
