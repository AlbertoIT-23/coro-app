// Everything stays in this browser, on this device. There is no server.

let opening = null;

function open() {
  opening ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('coro', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('clips', { keyPath: 'id' });
      db.createObjectStore('sessions', { keyPath: 'id' }).createIndex('clipId', 'clipId');
      db.createObjectStore('takes', { keyPath: ['sessionId', 'i'] }).createIndex('sessionId', 'sessionId');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function finished(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function store(name, mode = 'readonly') {
  return (await open()).transaction(name, mode).objectStore(name);
}

export async function putClip(clip) {
  await done((await store('clips', 'readwrite')).put(clip));
}

export async function getClip(id) {
  return done((await store('clips')).get(id));
}

export async function putTake(take) {
  await done((await store('takes', 'readwrite')).put(take));
}

export async function deleteTake(sessionId, i) {
  await done((await store('takes', 'readwrite')).delete([sessionId, i]));
}

export async function saveSession(session, takes) {
  const tx = (await open()).transaction(['sessions', 'takes'], 'readwrite');
  tx.objectStore('sessions').put(session);
  takes.forEach((t) => tx.objectStore('takes').put(t));
  await finished(tx);
}

export async function listSessions() {
  const all = await done((await store('sessions')).getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getSession(id) {
  return done((await store('sessions')).get(id));
}

export async function takesOf(sessionId) {
  const index = (await store('takes')).index('sessionId');
  const rows = await done(index.getAll(sessionId));
  return rows.sort((a, b) => a.i - b.i);
}

export async function oldestSessionOf(clipId) {
  const index = (await store('sessions')).index('clipId');
  const rows = await done(index.getAll(clipId));
  return rows.sort((a, b) => a.createdAt - b.createdAt)[0] || null;
}

// A clip with no sessions left has nothing pointing at it, so it goes too.
export async function deleteSession(id) {
  const session = await getSession(id);
  const takes = await takesOf(id);
  const tx = (await open()).transaction(['sessions', 'takes', 'clips'], 'readwrite');
  tx.objectStore('sessions').delete(id);
  takes.forEach((t) => tx.objectStore('takes').delete([t.sessionId, t.i]));
  if (session) {
    const left = await done(tx.objectStore('sessions').index('clipId').count(session.clipId));
    if (left === 0) tx.objectStore('clips').delete(session.clipId);
  }
  await finished(tx);
}

export async function askToKeepData() {
  try {
    await navigator.storage?.persist?.();
  } catch {}
}
