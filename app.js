const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const DB_NAME = "xhs-selection-pwa";
const DB_VERSION = 1;
let dbPromise = null;
let workerPromise = null;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains("shops")) {
        db.createObjectStore("shops", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("shop_snapshots")) {
        const store = db.createObjectStore("shop_snapshots", { keyPath: "id", autoIncrement: true });
        store.createIndex("shop_id", "shop_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("products")) {
        db.createObjectStore("products", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("product_snapshots")) {
        const store = db.createObjectStore("product_snapshots", { keyPath: "id", autoIncrement: true });
        store.createIndex("product_id", "product_id", { unique: false });
      }
      if (!db.objectStoreNames.contains("daily_stats")) {
        const store = db.createObjectStore("daily_stats", { keyPath: "id", autoIncrement: true });
        store.createIndex("product_id", "product_id", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function requestAsPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getAll(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, "readonly");
  return requestAsPromise(tx.objectStore(storeName).getAll());
}

async function addItem(storeName, value) {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  const key = await requestAsPromise(tx.objectStore(storeName).add(value));
  return key;
}

async function putItem(storeName, value) {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  await requestAsPromise(tx.objectStore(storeName).put(value));
}

async function getShop(shopId) {
  const shops = await getAll("shops");
  return shops.find((shop) => shop.id === shopId) || null;
}

async function getLatestSnapshot(shopId) {
  const snaps = await getAll("shop_snapshots");
  return snaps
    .filter((snap) => snap.shop_id === shopId)
    .sort((a, b) => new Date(b.snapshot_at) - new Date(a.snapshot_at))[0] || null;
}

function extractUrl(text) {
  const matches = String(text).match(/https?:\/\/[^\s)\]"'<>]+/g) || [];
  if (!matches.length) return String(text).trim();
  for (const match of matches) {
    const clean = match.replace(/[.,;!?]+$/, "");
    if (/xiaohongshu\.com|xhslink\.com/i.test(clean)) return clean;
  }
  return matches[0].replace(/[.,;!?]+$/, "");
}

async function addShop() {
  const inputText = $("#shop-input").value.trim();
  const url = extractUrl(inputText);
  const message = $("#shop-message");
  if (!inputText || !url) {
    message.textContent = "请粘贴小红书分享文案或店铺链接";
    return;
  }
  const shops = await getAll("shops");
  if (shops.some((shop) => shop.url === url)) {
    toast("该店铺已录入，无需重复录入");
    message.textContent = "该店铺已录入，无需重复录入";
    return;
  }
  const shop = {
    url,
    title: $("#shop-title").value.trim(),
    keyword: $("#shop-keyword").value.trim(),
    note: "",
    status: "candidate",
    source: "manual",
    score: 0,
    last_seen_at: null,
    seen_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  await addItem("shops", shop);
  $("#shop-input").value = "";
  $("#shop-title").value = "";
  $("#shop-keyword").value = "";
  message.textContent = "店铺已添加";
  toast("店铺已添加");
  renderAll();
}

async function selectTasks() {
  const shops = (await getAll("shops")).filter((shop) => shop.status !== "excluded");
  const now = Date.now();
  const recapture = [];
  const firsts = [];

  for (const shop of shops) {
    const last = await getLatestSnapshot(shop.id);
    if (!last) {
      firsts.push({ shop, reason: "新店，尚未截图" });
    } else if (last.stage === "first") {
      if (now - Date.parse(last.snapshot_at) >= 20 * 60 * 60 * 1000) {
        recapture.push({ shop, reason: "24小时回读" });
      }
    } else if (now - Date.parse(last.snapshot_at) >= 3 * 24 * 60 * 60 * 1000) {
      firsts.push({ shop, reason: "轮换复看" });
    }
  }

  recapture.sort(
    (a, b) => Date.parse(b.shop.last_seen_at || 0) - Date.parse(a.shop.last_seen_at || 0)
  );
  firsts.sort((a, b) => (a.shop.seen_count || 0) - (b.shop.seen_count || 0));

  return [...recapture.slice(0, 10), ...firsts.slice(0, 10)];
}

async function getOcrWorker() {
  if (!workerPromise) {
    if (!window.Tesseract) {
      throw new Error("OCR 引擎未加载，请检查网络后重试");
    }
    workerPromise = Tesseract.createWorker("chi_sim+eng", 1, {
      logger: (message) => {
        if (message.status === "recognizing text") {
          $("#header-status").textContent = `OCR ${Math.round(message.progress * 100)}%`;
        }
      },
    });
  }
  return workerPromise;
}

async function recognizeImage(file) {
  const worker = await getOcrWorker();
  const objectUrl = URL.createObjectURL(file);
  try {
    const { data } = await worker.recognize(objectUrl);
    return data.text || "";
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function uploadScreenshot(shopId, file) {
  const last = await getLatestSnapshot(shopId);
  const now = Date.now();
  let stage = "first";
  if (last) {
    const sameSession = now - Date.parse(last.snapshot_at) <= 10 * 60 * 1000;
    if (sameSession && last.stage === "first") stage = "first";
    else if (sameSession && last.stage === "recapture") stage = "recapture";
    else stage = last.stage === "first" ? "recapture" : "first";
  }

  toast("正在识别截图，请稍候");
  $("#header-status").textContent = "OCR 准备中";
  try {
    const text = await recognizeImage(file);
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const snap = {
      shop_id: shopId,
      snapshot_at: new Date().toISOString(),
      stage,
      imageBlob: file,
      ocr_lines: lines,
      created_at: new Date().toISOString(),
    };
    await addItem("shop_snapshots", snap);
    const shop = await getShop(shopId);
    if (shop) {
      shop.last_seen_at = snap.snapshot_at;
      shop.seen_count = (shop.seen_count || 0) + 1;
      shop.updated_at = snap.snapshot_at;
      await putItem("shops", shop);
    }
    $("#header-status").textContent = "本地版";
    toast(`已保存，识别 ${lines.length} 行`);
    renderAll();
  } catch (error) {
    $("#header-status").textContent = "本地版";
    toast(`识别失败：${error.message}`);
  }
}

function shopCard(shop) {
  return `
    <div class="item">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(shop.title || "未命名店铺")}</div>
          <div class="item-meta">${escapeHtml(shop.keyword || "无关键词")} · ${escapeHtml(shop.status)} · 已看 ${shop.seen_count || 0} 次</div>
          <div class="item-meta">${escapeHtml(shop.url)}</div>
        </div>
      </div>
      <div class="item-actions">
        <a href="${escapeHtml(shop.url)}" target="_blank" rel="noopener">打开店铺</a>
        <button data-upload-shop="${shop.id}">上传截图</button>
        <button class="ghost" data-view-shop="${shop.id}">查看识别</button>
        <button class="ghost" data-edit-shop="${shop.id}">编辑</button>
        <button class="danger" data-exclude-shop="${shop.id}">排除</button>
      </div>
    </div>`;
}

function taskCard(task) {
  const shop = task.shop;
  return `
    <div class="item">
      <div class="item-head">
        <div>
          <span class="badge ${task.task_type === "recapture" ? "warn" : ""}">${escapeHtml(task.reason)}</span>
          <div class="item-title">${escapeHtml(shop.title || "未命名店铺")}</div>
          <div class="item-meta">${escapeHtml(shop.keyword || "无关键词")}</div>
          <div class="item-meta">${escapeHtml(shop.url)}</div>
        </div>
      </div>
      <div class="item-actions">
        <a href="${escapeHtml(shop.url)}" target="_blank" rel="noopener">打开店铺</a>
        <button data-upload-shop="${shop.id}">上传截图</button>
        <button class="ghost" data-view-shop="${shop.id}">查看识别</button>
      </div>
    </div>`;
}

function snapshotCard(snap, shop) {
  const imageUrl = snap.imageBlob ? URL.createObjectURL(snap.imageBlob) : "";
  return `
    <div class="item">
      <div class="item-head">
        <div>
          <span class="badge">${escapeHtml(snap.stage === "first" ? "首次采集" : "24小时回读")}</span>
          <div class="item-title">${escapeHtml(shop?.title || "店铺")}</div>
          <div class="item-meta">${escapeHtml(new Date(snap.snapshot_at).toLocaleString())}</div>
        </div>
      </div>
      ${imageUrl ? `<img src="${imageUrl}" alt="店铺截图" style="width:100%;border-radius:8px;margin-top:8px">` : ""}
      <div class="ocr-text">${escapeHtml((snap.ocr_lines || []).join("\n"))}</div>
    </div>`;
}

async function renderTasks() {
  const tasks = await selectTasks();
  $("#stat-tasks").textContent = tasks.length;
  const list = $("#task-list");
  if (!tasks.length) {
    list.innerHTML = '<div class="card">今天暂无任务，请先添加店铺。</div>';
    return;
  }
  list.innerHTML = tasks.map(taskCard).join("");
}

async function renderShops() {
  const shops = (await getAll("shops")).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  $("#stat-shops").textContent = shops.length;
  const list = $("#shop-list");
  if (!shops.length) {
    list.innerHTML = '<div class="card">还没有店铺，先在上方添加。</div>';
    return;
  }
  list.innerHTML = shops.map(shopCard).join("");
}

async function renderRecords() {
  const snaps = (await getAll("shop_snapshots")).sort(
    (a, b) => new Date(b.snapshot_at) - new Date(a.snapshot_at)
  );
  $("#stat-snapshots").textContent = snaps.length;
  const list = $("#record-list");
  if (!snaps.length) {
    list.innerHTML = '<div class="card">还没有截图记录。</div>';
    return;
  }
  const shops = await getAll("shops");
  list.innerHTML = snaps.map((snap) => snapshotCard(snap, shops.find((s) => s.id === snap.shop_id))).join("");
}

async function renderAll() {
  await Promise.all([renderTasks(), renderShops(), renderRecords()]);
}

async function showLastRecognition(shopId) {
  const last = await getLatestSnapshot(shopId);
  const shop = await getShop(shopId);
  if (!last) {
    toast("这家店还没有截图记录");
    return;
  }
  const lines = (last.ocr_lines || []).join("\n") || "无识别文本";
  alert(`${shop?.title || "店铺"}\n\n${lines}`);
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2400);
}

function exportCsv() {
  const build = async () => {
    const shops = await getAll("shops");
    const snaps = await getAll("shop_snapshots");
    const rows = [
      ["日期", "店铺", "链接", "阶段", "识别行数", "识别文本"],
    ];
    for (const snap of snaps.sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at))) {
      const shop = shops.find((s) => s.id === snap.shop_id) || {};
      rows.push([
        new Date(snap.snapshot_at).toLocaleString(),
        shop.title || "",
        shop.url || "",
        snap.stage,
        String(snap.ocr_lines?.length || 0),
        (snap.ocr_lines || []).join("\n"),
      ]);
    }
    const csv = rows
      .map((row) => row.map((cell) => `"${String(cell ?? "").replaceAll('"', '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "小红书选品记录.csv";
    a.click();
    URL.revokeObjectURL(url);
  };
  build().catch((error) => toast(`导出失败：${error.message}`));
}

function bindEvents() {
  $$(".bottom-nav button").forEach((button) => {
    button.addEventListener("click", () => {
      $$(".bottom-nav button").forEach((b) => b.classList.remove("active"));
      $$(".page").forEach((p) => p.classList.remove("active"));
      button.classList.add("active");
      $(`#${button.dataset.page}`).classList.add("active");
    });
  });

  $("#add-shop").addEventListener("click", addShop);
  $("#refresh-tasks").addEventListener("click", renderTasks);
  $("#refresh-shops").addEventListener("click", renderShops);
  $("#refresh-records").addEventListener("click", renderRecords);
  $("#export-csv").addEventListener("click", exportCsv);

  $("#screenshot-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    const shopId = event.target.dataset.shopId;
    if (!file || !shopId) return;
    uploadScreenshot(Number(shopId), file);
    event.target.value = "";
  });

  document.addEventListener("click", (event) => {
    const uploadBtn = event.target.closest("[data-upload-shop]");
    if (uploadBtn) {
      const input = $("#screenshot-file");
      input.dataset.shopId = uploadBtn.dataset.uploadShop;
      input.value = "";
      input.click();
      return;
    }

    const viewBtn = event.target.closest("[data-view-shop]");
    if (viewBtn) {
      showLastRecognition(Number(viewBtn.dataset.viewShop));
      return;
    }

    const editBtn = event.target.closest("[data-edit-shop]");
    if (editBtn) {
      const shopId = Number(editBtn.dataset.editShop);
      const url = prompt("新的店铺链接或分享文案");
      if (url === null) return;
      const title = prompt("店铺名称（可留空）", "");
      const keyword = prompt("主营关键词（可留空）", "");
      getShop(shopId).then((shop) => {
        if (!shop) return;
        shop.url = extractUrl(url) || shop.url;
        shop.title = title || shop.title;
        shop.keyword = keyword || shop.keyword;
        shop.updated_at = new Date().toISOString();
        putItem("shops", shop).then(renderAll);
      });
      return;
    }

    const excludeBtn = event.target.closest("[data-exclude-shop]");
    if (excludeBtn) {
      if (!confirm("确认排除这家店铺吗？")) return;
      const shopId = Number(excludeBtn.dataset.excludeShop);
      getShop(shopId).then((shop) => {
        if (!shop) return;
        shop.status = "excluded";
        shop.updated_at = new Date().toISOString();
        putItem("shops", shop).then(renderAll);
      });
    }
  });
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}

if (navigator.storage && navigator.storage.persist) {
  navigator.storage.persist().catch(() => {});
}

bindEvents();
renderAll();
