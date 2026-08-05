export function createReceiver({ openSink, onFileStart, onProgress, onFileDone, onDone }) {
  let sink = null;
  let current = null;
  let received = 0;

  async function finish() {
    if (!sink) return;
    const finished = current;
    const target = sink;
    sink = null;
    current = null;
    await target.close();
    onFileDone?.(finished);
  }

  async function startFile(meta) {
    await finish();
    current = { name: meta.name, size: meta.size, mime: meta.mime };
    received = 0;
    sink = await openSink(current);
    onFileStart?.(current);
    if (current.size === 0) await finish();
  }

  async function handleControl(raw) {
    const meta = JSON.parse(raw);
    if (meta.t === 'file') await startFile(meta);
    else if (meta.t === 'done') {
      await finish();
      onDone?.();
    }
  }

  async function handleChunk(chunk) {
    if (!sink || !current) return;
    const remaining = current.size - received;
    if (remaining <= 0) return;

    const data = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
    await sink.write(data);
    received += data.byteLength;
    onProgress?.(received, current.size);
    if (received >= current.size) await finish();
  }

  return {
    async handle(chunk) {
      if (typeof chunk === 'string') await handleControl(chunk);
      else await handleChunk(chunk);
    },
    async abort() {
      const target = sink;
      sink = null;
      current = null;
      if (target) await target.abort?.();
    },
  };
}
