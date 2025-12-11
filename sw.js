const DB_NAME = "allure-local-drop";
const DB_STORE = "files";
let memoryCache = new Map();

// --- LIFECYCLE ---
self.addEventListener("install", (event) => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
  console.log("[SW] Activated. Ready.");
});

// --- INDEXED DB UTILS ---
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "path" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function blobToArrayBuffer(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function putBatchFilesToDB(filesMap) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    tx.oncomplete = () => { db.close(); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };

    (async () => {
      for (const [path, blob] of filesMap.entries()) {
        const buffer = await blobToArrayBuffer(blob);
        const mimeType = blob.type || "application/octet-stream";
        store.put({ path, buffer, mimeType });
      }
    })();
  });
}

async function getFileFromDB(path) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(path);
    req.onsuccess = () => {
      const result = req.result;
      db.close();
      if (result) resolve(new Blob([result.buffer], { type: result.mimeType }));
      else resolve(null);
    };
    req.onerror = () => { db.close(); reject(req.error); };
  });
}

async function clearDB() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    store.clear();
    tx.oncomplete = () => { db.close(); resolve(); };
  });
}

// --- MESSAGE HANDLING ---
self.addEventListener("message", (event) => {
  if (!event.data) return;

  if (event.data.type === "FILE_LIST") {
    const payload = event.data.files;
    memoryCache.clear();
    if (payload && typeof payload === "object") {
      for (const key of Object.keys(payload)) memoryCache.set(key, payload[key]);
    }
    // Persist to DB
    (async () => {
      try {
        await clearDB();
        await putBatchFilesToDB(memoryCache);
        console.log("[SW] All files persisted to DB.");
      } catch (err) {
        console.error("[SW] DB Persist Error:", err);
      }
    })();
  } else if (event.data.type === "CLEAR_PERSISTENCE") {
    memoryCache.clear();
    clearDB().then(() => console.log("[SW] DB Cleared."));
  }
});

// --- FETCH HANDLING ---
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname.includes("/__view__/")) {
    event.respondWith(
      (async () => {
        let path = url.pathname.split("/__view__/")[1];
        path = decodeURIComponent(path);

        // 1. Cek Memory, 2. Cek DB
        let blob = memoryCache.get(path);
        if (!blob) blob = await getFileFromDB(path);

        if (blob) {
          let contentType = blob.type;
          // Logic Content Type (Fixed position)
          if (!contentType || contentType === "application/octet-stream") {
            if (path.endsWith(".html")) contentType = "text/html";
            else if (path.endsWith(".css")) contentType = "text/css";
            else if (path.endsWith(".js")) contentType = "application/javascript";
            else if (path.endsWith(".json")) contentType = "application/json";
            else if (path.endsWith(".png")) contentType = "image/png";
            else if (path.endsWith(".svg")) contentType = "image/svg+xml";
            else if (path.endsWith(".ico")) contentType = "image/x-icon";
          }

          return new Response(blob, {
            status: 200,
            headers: {
              "Content-Type": contentType,
              "Cache-Control": "no-store", 
            },
          });
        } else {
          return new Response("File not found in Allure Report", { status: 404 });
        }
      })()
    );
  }
});