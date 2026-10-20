// Recordings: 16-bit mono PCM in IndexedDB, stored in half-second chunks as
// they come in (nothing is lost if the app is closed mid-recording) and put
// together as a WAV file for playback and download.

const DB_NAME = 'schall';
let connection;

function open() {
  connection ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('recordings', { keyPath: 'id', autoIncrement: true });
      db.createObjectStore('chunks', { keyPath: ['id', 'index'] });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return connection;
}

const completion = (tx) =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });

const result = (request) =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const chunkRange = (id) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

/** Starts a recording; returns a writer for its PCM chunks. */
export async function startRecording(meta) {
  navigator.storage?.persist?.().catch(() => {});
  const db = await open();
  const row = { ...meta, created: Date.now(), samples: 0 };
  const tx = db.transaction('recordings', 'readwrite');
  row.id = await result(tx.objectStore('recordings').add(row));
  await completion(tx);
  let index = 0;
  let queue = Promise.resolve();
  const save = (chunk) => {
    const snapshot = { ...row };
    const i = index++;
    queue = queue.then(async () => {
      const t = db.transaction(['recordings', 'chunks'], 'readwrite');
      if (chunk) t.objectStore('chunks').put({ id: row.id, index: i, data: chunk.buffer });
      t.objectStore('recordings').put(snapshot);
      await completion(t);
    });
    return queue;
  };
  return {
    id: row.id,
    get seconds() {
      return row.samples / row.sampleRate;
    },
    write(int16) {
      row.samples += int16.length;
      return save(int16);
    },
    finish(extra) {
      Object.assign(row, extra, { done: true });
      return save(null);
    },
  };
}

export async function listRecordings() {
  const db = await open();
  const rows = await result(db.transaction('recordings').objectStore('recordings').getAll());
  return rows.sort((a, b) => b.created - a.created);
}

export async function recordingFile(row) {
  const db = await open();
  const chunks = await result(db.transaction('chunks').objectStore('chunks').getAll(chunkRange(row.id)));
  const data = chunks.map((c) => c.data);
  const bytes = data.reduce((sum, d) => sum + d.byteLength, 0);
  return new File([wavHeader(bytes / 2, row.sampleRate), ...data], fileName(row.created), {
    type: 'audio/wav',
  });
}

export async function deleteRecording(id) {
  const db = await open();
  const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
  tx.objectStore('recordings').delete(id);
  tx.objectStore('chunks').delete(chunkRange(id));
  await completion(tx);
}

export function fileName(created) {
  const d = new Date(created);
  const p = (n) => String(n).padStart(2, '0');
  return `schall-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.wav`;
}

// 44-byte RIFF header for 16-bit mono PCM.
export function wavHeader(samples, sampleRate) {
  const header = new DataView(new ArrayBuffer(44));
  const text = (offset, s) => {
    for (let i = 0; i < s.length; i++) header.setUint8(offset + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  header.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, samples * 2, true);
  return header.buffer;
}
