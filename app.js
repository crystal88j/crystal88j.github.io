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

async function getShopSnapshots(shopId) {
  const snaps = await getAll("shop_snapshots");
  return snaps
    .filter((snap) => snap.shop_id === shopId)
    .sort((a, b) => new Date(a.snapshot_at) - new Date(b.snapshot_at));
}

async function getSnapshot(snapshotId) {
  const snaps = await getAll("shop_snapshots");
  return snaps.find((snap) => snap.id === snapshotId) || null;
}

async function deleteItem(storeName, key) {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  await requestAsPromise(tx.objectStore(storeName).delete(key));
}

async function deleteShop(shopId) {
  const products = (await getAll("products")).filter((p) => p.shop_id === shopId);
  const productIds = new Set(products.map((p) => p.id));
  for (const product of products) {
    await deleteItem("products", product.id);
  }
  const productSnapshots = await getAll("product_snapshots");
  for (const snap of productSnapshots) {
    if (productIds.has(snap.product_id)) {
      await deleteItem("product_snapshots", snap.id);
    }
  }
  const shopSnapshots = (await getAll("shop_snapshots")).filter(
    (snap) => snap.shop_id === shopId
  );
  for (const snap of shopSnapshots) {
    await deleteItem("shop_snapshots", snap.id);
  }
  await deleteItem("shops", shopId);
}

async function clearStore(storeName) {
  const db = await openDB();
  const tx = db.transaction(storeName, "readwrite");
  await requestAsPromise(tx.objectStore(storeName).clear());
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

function extractShopName(text) {
  const match = String(text).match(/(?:推荐|分享)小红书好店\s*([^\s，,。；;\[\]()]+)/);
  return match ? match[1] : "";
}

function extractShopNameFromOcr(items) {
  const candidates = items
    .filter((item) => {
      const [x, y] = itemCenter(item);
      const text = item.text;
      return (
        y >= 200 &&
        y <= 500 &&
        x >= 100 &&
        x <= 360 &&
        text.length >= 2 &&
        text.length <= 12 &&
        !/\d/.test(text) &&
        !isNoise(text)
      );
    })
    .sort((a, b) => itemCenter(a)[1] - itemCenter(b)[1]);
  return candidates.length ? candidates[0].text : "";
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
  const autoTitle = extractShopName(inputText);
  if (autoTitle && !$("#shop-title").value.trim()) {
    $("#shop-title").value = autoTitle;
  }
  const shop = {
    url,
    title: $("#shop-title").value.trim() || autoTitle,
    keyword: $("#shop-keyword").value.trim(),
    note: "",
    category: "",
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
  message.textContent = autoTitle
    ? "店铺已添加"
    : "店铺已添加，上传截图后会从截图补全店铺名";
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
    return { text: data.text || "", items: flattenOcrItems(data) };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function flattenOcrItems(data) {
  const items = [];
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node.text && node.bbox) {
      items.push({
        text: node.text,
        box: [
          [node.bbox.x0, node.bbox.y0],
          [node.bbox.x1, node.bbox.y0],
          [node.bbox.x1, node.bbox.y1],
          [node.bbox.x0, node.bbox.y1],
        ],
        score: node.confidence ?? 0,
      });
    }
    if (node.blocks) node.blocks.forEach(walk);
    if (node.paragraphs) node.paragraphs.forEach(walk);
    if (node.lines) node.lines.forEach(walk);
    if (node.words) node.words.forEach(walk);
  };
  walk(data);
  return items;
}

function normText(value) {
  return String(value || "")
    .replace(/[\s\-—|/_·:：,，。.]+/g, "")
    .replace(/[^\u4e00-\u9fff0-9A-Za-z]/g, "");
}

function itemCenter(item) {
  const box = item.box;
  const xs = box.map((point) => point[0]);
  const ys = box.map((point) => point[1]);
  return [xs.reduce((a, b) => a + b, 0) / xs.length, ys.reduce((a, b) => a + b, 0) / ys.length];
}

function priceFromLine(text) {
  const match = String(text).match(/[¥￥]\s*(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function salesFromLine(text) {
  const match = String(text).match(/已售\s*([\d.]+)\s*(万|千)?/);
  if (!match) return null;
  let number = Number(match[1]);
  if (match[2] === "万") number *= 10000;
  if (match[2] === "千") number *= 1000;
  return Math.round(number);
}

function isNoise(text) {
  return /(当月加购|当月热销|店铺新客|日讲解|电子版|精品资料包|支持手机|可打印|自动发货|持续更新|下单秒发|已领|新课标|2025新版|2026新版|2025秋新版|2026秋新版|2025-2026|真题持续更新中|极速退款|客服平均|好评率|粉丝|篇笔记)/.test(text);
}

function parseProductsFromItems(items) {
  const tabWords = new Set(["综合", "销量", "新品", "价格"]);
  const tabY = items
    .filter((item) => tabWords.has(item.text))
    .map((item) => itemCenter(item)[1]);
  const xs = items.map((item) => itemCenter(item)[0]);
  const maxX = Math.max(1, ...xs);
  const columnThreshold = maxX * 0.5;
  const salesY = items
    .filter((item) => salesFromLine(item.text) !== null)
    .map((item) => itemCenter(item)[1]);
  let startY = tabY.length
    ? Math.max(...tabY) + 25
    : salesY.length
      ? Math.min(...salesY) - 400
      : 0;
  startY = Math.max(0, startY);
  const columns = [[], []];
  for (const item of items) {
    const [x, y] = itemCenter(item);
    if (y < startY) continue;
    columns[x < columnThreshold ? 0 : 1].push(item);
  }

  const products = [];
  for (const column of columns) {
    column.sort((a, b) => itemCenter(a)[1] - itemCenter(b)[1]);
    const anchors = [];
    column.forEach((item, index) => {
      if (salesFromLine(item.text) !== null) anchors.push(index);
    });
    anchors.forEach((anchor, anchorIndex) => {
      const start = anchorIndex > 0 ? anchors[anchorIndex - 1] + 1 : 0;
      const lines = column.slice(start, anchor + 1).sort(
        (a, b) => itemCenter(a)[1] - itemCenter(b)[1] || itemCenter(a)[0] - itemCenter(b)[0]
      );
      let price = null;
      let sales = null;
      const titleParts = [];
      for (const line of lines) {
        const text = line.text.trim();
        const priceValue = priceFromLine(text);
        const salesValue = salesFromLine(text);
        if (priceValue !== null) price = priceValue;
        if (salesValue !== null) sales = salesValue;
        if (priceValue === null && salesValue === null && !isNoise(text)) {
          titleParts.push(text);
        }
      }
      if (sales === null) return;
      products.push({
        title: titleParts.join(" "),
        price,
        sales,
        lines: lines.map((line) => line.text.trim()),
      });
    });
  }
  return products;
}

function textSimilarity(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const pairsA = new Set();
  const pairsB = new Set();
  for (let i = 0; i < na.length - 1; i++) pairsA.add(na.slice(i, i + 2));
  for (let i = 0; i < nb.length - 1; i++) pairsB.add(nb.slice(i, i + 2));
  if (!pairsA.size || !pairsB.size) return 0;
  let overlap = 0;
  pairsA.forEach((pair) => {
    if (pairsB.has(pair)) overlap += 1;
  });
  return (2 * overlap) / (pairsA.size + pairsB.size);
}

function matchProducts(first, second, minScore = 0.5) {
  const used = new Set();
  const result = [];
  for (const p1 of first) {
    let bestIndex = -1;
    let bestScore = minScore;
    second.forEach((p2, idx) => {
      if (used.has(idx)) return;
      let score = textSimilarity(p1.title, p2.title);
      if (p1.price !== null && p2.price !== null && Math.abs(p1.price - p2.price) < 0.01) {
        score += 0.08;
      }
      if (score > bestScore) {
        bestScore = score;
        bestIndex = idx;
      }
    });
    if (bestIndex >= 0) {
      used.add(bestIndex);
      const p2 = second[bestIndex];
      const delta = (p2.sales || 0) - (p1.sales || 0);
      result.push({
        title: p1.title,
        price_t0: p1.price,
        price_t1: p2.price,
        sales_t0: p1.sales,
        sales_t1: p2.sales,
        daily_sales: delta,
        daily_gmv: Math.round(delta * (p2.price ?? p1.price ?? 0) * 100) / 100,
        score: Math.round(bestScore * 1000) / 1000,
      });
    }
  }
  return result;
}

async function computeDailyForShop(shopId) {
  const snaps = await getShopSnapshots(shopId);
  if (snaps.length < 2) return 0;
  const firstSnap = snaps[0];
  const secondSnap = snaps[snaps.length - 1];
  const firstProducts = firstSnap.parsedProducts || [];
  const secondProducts = secondSnap.parsedProducts || [];
  if (!firstProducts.length || !secondProducts.length) return 0;
  const pairs = matchProducts(firstProducts, secondProducts);
  const intervalMs = Date.parse(secondSnap.snapshot_at) - Date.parse(firstSnap.snapshot_at);
  const intervalDays = intervalMs / 86400000;
  const dailyFactor = intervalDays >= 1.2 ? intervalDays : 1;
  const threshold = Number($("#quality-threshold")?.value || 5);
  let count = 0;
  for (const row of pairs) {
    const rawDelta = row.daily_sales;
    row.daily_sales = dailyFactor > 1 ? Math.round((rawDelta / dailyFactor) * 10) / 10 : rawDelta;
    row.daily_gmv = Math.round(row.daily_sales * (row.price_t1 ?? row.price_t0 ?? 0) * 100) / 100;
    row.interval_days = dailyFactor > 1 ? Math.round(intervalDays * 10) / 10 : 1;
    const products = await getAll("products");
    let product = products.find(
      (p) => p.shop_id === shopId && textSimilarity(p.title, row.title) > 0.6
    );
    if (!product) {
      product = {
        shop_id: shopId,
        title: row.title,
        status: "candidate",
        note: "",
        product_url: "",
        price_t1: row.price_t1,
        sales_t1: row.sales_t1,
        daily_sales: row.daily_sales,
        daily_gmv: row.daily_gmv,
        interval_days: row.interval_days,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      product.id = await addItem("products", product);
    } else {
      product.price_t1 = row.price_t1;
      product.sales_t1 = row.sales_t1;
      product.daily_sales = row.daily_sales;
      product.daily_gmv = row.daily_gmv;
      product.interval_days = row.interval_days;
      product.updated_at = new Date().toISOString();
      await putItem("products", product);
    }
    if (
      row.daily_sales >= threshold &&
      product.status !== "listed" &&
      product.status !== "discarded"
    ) {
      product.status = "quality";
      await putItem("products", product);
    }
    count += 1;
  }
  return count;
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
    const { text, items } = await recognizeImage(file);
    const imageData = await file.arrayBuffer();
    const lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const parsedProducts = parseProductsFromItems(items);
    const snap = {
      shop_id: shopId,
      snapshot_at: new Date().toISOString(),
      stage,
      imageData,
      imageMime: file.type || "image/*",
      ocr_lines: lines,
      parsedProducts,
      created_at: new Date().toISOString(),
    };
    await addItem("shop_snapshots", snap);
    const shop = await getShop(shopId);
    if (shop) {
      if (!shop.title || shop.title === "未命名店铺" || shop.title.startsWith("未命名")) {
        const detectedName = extractShopNameFromOcr(items);
        if (detectedName) {
          shop.title = detectedName;
        }
      }
      shop.last_seen_at = snap.snapshot_at;
      shop.seen_count = (shop.seen_count || 0) + 1;
      shop.updated_at = snap.snapshot_at;
      await putItem("shops", shop);
    }
    $("#header-status").textContent = "本地版";
    const matched = await computeDailyForShop(shopId);
    toast(`已保存，识别 ${lines.length} 行，匹配 ${matched} 个商品`);
    renderAll();
  } catch (error) {
    $("#header-status").textContent = "本地版";
    toast(`识别失败：${error.message}`);
  }
}

async function replaceSnapshot(snapshotId, file) {
  const snap = await getSnapshot(snapshotId);
  if (!snap) {
    toast("记录不存在");
    return;
  }
  toast("正在替换截图，请稍候");
  try {
    const { text, items } = await recognizeImage(file);
    snap.imageData = await file.arrayBuffer();
    snap.imageMime = file.type || "image/*";
    snap.ocr_lines = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    snap.parsedProducts = parseProductsFromItems(items);
    snap.snapshot_at = new Date().toISOString();
    await putItem("shop_snapshots", snap);
    const matched = await computeDailyForShop(snap.shop_id);
    toast(`截图已替换，匹配 ${matched} 个商品`);
    renderAll();
  } catch (error) {
    toast(`替换失败：${error.message}`);
  }
}

function shopCard(shop) {
  return `
    <div class="item">
      <div class="item-head">
        <div>
          <div class="item-title">${escapeHtml(shop.title || "未命名店铺")}</div>
          <div class="item-meta">${escapeHtml(shop.keyword || "无关键词")} · ${escapeHtml(shop.status)} · 已看 ${shop.seen_count || 0} 次</div>
          <div class="item-meta">分类：${escapeHtml(shop.category || "未分类")} · 备注：${escapeHtml(shop.note || "无")}</div>
          <div class="item-meta">${escapeHtml(shop.url)}</div>
        </div>
      </div>
      <div class="item-actions">
        <a href="${escapeHtml(shop.url)}" target="_blank" rel="noopener">打开店铺</a>
        <button data-upload-shop="${shop.id}">上传截图</button>
        <button class="ghost" data-view-shop="${shop.id}">查看识别</button>
        <button class="ghost" data-note-shop="${shop.id}">备注/分类</button>
        ${shop.status === "excluded"
          ? `<button class="ghost" data-restore-shop="${shop.id}">恢复</button>`
          : `<button class="danger" data-exclude-shop="${shop.id}">排除</button>`}
        <button class="danger" data-delete-shop="${shop.id}">删除店铺</button>
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
  const imageUrl = snap.imageData
    ? URL.createObjectURL(new Blob([snap.imageData], { type: snap.imageMime || "image/*" }))
    : snap.imageBlob
      ? URL.createObjectURL(snap.imageBlob)
      : "";
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
      <div class="item-actions">
        <button data-replace-snapshot="${snap.id}" data-shop-id="${snap.shop_id}">替换截图</button>
        <button class="danger" data-delete-snapshot="${snap.id}">删除记录</button>
      </div>
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
  const byShop = new Map();
  for (const snap of snaps) {
    if (!byShop.has(snap.shop_id)) byShop.set(snap.shop_id, []);
    byShop.get(snap.shop_id).push(snap);
  }
  const shopsWithRecords = [...byShop.keys()]
    .map((shopId) => shops.find((shop) => shop.id === shopId))
    .filter(Boolean)
    .sort((a, b) => {
      const aLatest = byShop.get(a.id)[0].snapshot_at;
      const bLatest = byShop.get(b.id)[0].snapshot_at;
      return new Date(bLatest) - new Date(aLatest);
    });
  list.innerHTML = shopsWithRecords
    .map((shop) => {
      const items = byShop.get(shop.id);
      return `
        <details class="item shop-record">
          <summary>
            <div class="item-title">${escapeHtml(shop.title || "未命名店铺")}</div>
            <div class="item-meta">${escapeHtml(shop.url)} · ${items.length} 条记录</div>
          </summary>
          ${items.map((snap) => snapshotCard(snap, shop)).join("")}
        </details>`;
    })
    .join("");
}

async function renderLibrary() {
  const products = await getAll("products");
  const shops = await getAll("shops");
  const hideListed = $("#hide-listed").checked;
  const visible = products.filter(
    (product) => !hideListed || product.status !== "listed"
  );
  visible.sort((a, b) => {
    if (a.status === "listed" && b.status !== "listed") return 1;
    if (b.status === "listed" && a.status !== "listed") return -1;
    return (b.daily_sales || 0) - (a.daily_sales || 0);
  });
  const list = $("#library-list");
  if (!visible.length) {
    list.innerHTML = '<div class="card">暂无产品。上传两次同店截图后会自动生成。</div>';
    return;
  }
  list.innerHTML = visible
    .map((product) => {
      const shop = shops.find((s) => s.id === product.shop_id) || {};
      const statusLabel = {
        candidate: "待观察",
        quality: "优质",
        listed: "已上架",
        discarded: "已删除",
      }[product.status] || product.status;
      return `
        <div class="item">
          <div class="badge ${product.status === "quality" ? "warn" : ""}">${escapeHtml(statusLabel)}</div>
          <div class="item-title">${escapeHtml(product.title)}</div>
          <div class="item-meta">${escapeHtml(shop.title || "店铺")}</div>
          <div class="item-meta">日均销 ${escapeHtml(product.daily_sales ?? "-")} · 间隔 ${escapeHtml(product.interval_days || 1)} 天 · 单价 ${escapeHtml(product.price_t1 ?? "-")} · 累计 ${escapeHtml(product.sales_t1 ?? "-")} · GMV ${escapeHtml(product.daily_gmv ?? "-")}</div>
          <div class="item-meta">${product.product_url ? `<a href="${escapeHtml(product.product_url)}" target="_blank" rel="noopener">商品链接</a>` : "暂无商品链接"}</div>
          <div class="item-meta">备注：${escapeHtml(product.note || "无")}</div>
          <div class="item-actions">
            <button data-list-product="${product.id}">标记已上架</button>
            <button class="ghost" data-product-url="${product.id}">填写商品链接</button>
            <button class="ghost" data-note-product="${product.id}">备注</button>
            <button class="danger" data-delete-product="${product.id}">删除</button>
          </div>
        </div>`;
    })
    .join("");
}

async function renderAll() {
  await Promise.all([renderTasks(), renderShops(), renderRecords(), renderLibrary()]);
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

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportBackup() {
  const storeNames = ["shops", "shop_snapshots", "products", "product_snapshots", "daily_stats"];
  const data = {
    version: 1,
    exported_at: new Date().toISOString(),
    stores: {},
  };
  for (const name of storeNames) {
    data.stores[name] = await getAll(name);
  }
  for (const snap of data.stores.shop_snapshots || []) {
    if (snap.imageData && snap.imageData.byteLength) {
      snap.imageData = arrayBufferToBase64(snap.imageData);
    }
  }
  const blob = new Blob([JSON.stringify(data)], { type: "application/json" });
  downloadBlob(blob, `选品助手备份_${new Date().toISOString().slice(0, 10)}.json`);
  toast("备份已导出");
}

async function importBackup(file) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || !data.stores) {
    throw new Error("这不是有效的备份文件");
  }
  if (!confirm("导入会覆盖当前全部数据，确认继续吗？")) return;
  const storeNames = ["shops", "shop_snapshots", "products", "product_snapshots", "daily_stats"];
  for (const name of storeNames) {
    await clearStore(name);
  }
  for (const name of storeNames) {
    for (const item of data.stores[name] || []) {
      if (name === "shop_snapshots" && item.imageData && typeof item.imageData === "string") {
        item.imageData = base64ToArrayBuffer(item.imageData);
      }
      await addItem(name, item);
    }
  }
  toast("备份已恢复");
  renderAll();
}

function exportCsv() {
  const build = async () => {
    const shops = await getAll("shops");
    const snaps = await getAll("shop_snapshots");
    const products = await getAll("products");
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
    rows.push([]);
    rows.push(["产品库更新时间", "店铺", "商品", "日均销量", "间隔天数", "单价", "累计销量", "日GMV", "状态", "备注"]);
    for (const product of products) {
      const shop = shops.find((s) => s.id === product.shop_id) || {};
      rows.push([
        product.updated_at ? new Date(product.updated_at).toLocaleString() : "",
        shop.title || "",
        product.title || "",
        product.daily_sales ?? "",
        product.interval_days || "",
        product.price_t1 ?? "",
        product.sales_t1 ?? "",
        product.daily_gmv ?? "",
        product.status || "",
        product.note || "",
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
  $("#shop-input").addEventListener("input", (event) => {
    const titleInput = $("#shop-title");
    const name = extractShopName(event.target.value);
    if (name && (!titleInput.value.trim() || titleInput.dataset.auto === "true")) {
      titleInput.value = name;
      titleInput.dataset.auto = "true";
    } else if (!event.target.value.trim()) {
      titleInput.value = "";
      delete titleInput.dataset.auto;
    }
  });
  $("#refresh-tasks").addEventListener("click", renderTasks);
  $("#refresh-shops").addEventListener("click", renderShops);
  $("#refresh-records").addEventListener("click", renderRecords);
  $("#export-csv").addEventListener("click", exportCsv);
  $("#export-backup").addEventListener("click", () => {
    exportBackup().catch((error) => toast(`备份失败：${error.message}`));
  });
  $("#import-backup").addEventListener("click", () => {
    $("#backup-file").click();
  });
  $("#backup-file").addEventListener("change", async (event) => {
    const file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      await importBackup(file);
    } catch (error) {
      toast(`恢复失败：${error.message}`);
    }
    event.target.value = "";
  });
  $("#quality-threshold").addEventListener("change", renderLibrary);
  $("#hide-listed").addEventListener("change", renderLibrary);
  $("#recompute-all").addEventListener("click", async () => {
    const shops = await getAll("shops");
    let count = 0;
    for (const shop of shops) {
      count += await computeDailyForShop(shop.id);
    }
    toast(`重新计算完成，更新 ${count} 个商品`);
    renderLibrary();
  });

  $("#screenshot-file").addEventListener("change", (event) => {
    const file = event.target.files && event.target.files[0];
    const shopId = event.target.dataset.shopId;
    const replaceId = event.target.dataset.replaceSnapshotId;
    if (!file) return;
    if (replaceId) {
      replaceSnapshot(Number(replaceId), file);
    } else if (shopId) {
      uploadScreenshot(Number(shopId), file);
    }
    event.target.value = "";
    delete event.target.dataset.replaceSnapshotId;
  });

  document.addEventListener("click", (event) => {
    const uploadBtn = event.target.closest("[data-upload-shop]");
    if (uploadBtn) {
      const input = $("#screenshot-file");
      input.dataset.shopId = uploadBtn.dataset.uploadShop;
      delete input.dataset.replaceSnapshotId;
      input.value = "";
      input.click();
      return;
    }

    const replaceBtn = event.target.closest("[data-replace-snapshot]");
    if (replaceBtn) {
      const input = $("#screenshot-file");
      input.dataset.replaceSnapshotId = replaceBtn.dataset.replaceSnapshot;
      input.dataset.shopId = replaceBtn.dataset.shopId;
      input.value = "";
      input.click();
      return;
    }

    const deleteSnapBtn = event.target.closest("[data-delete-snapshot]");
    if (deleteSnapBtn) {
      if (!confirm("确认删除这条截图记录吗？")) return;
      deleteItem("shop_snapshots", Number(deleteSnapBtn.dataset.deleteSnapshot)).then(renderAll);
      return;
    }

    const listProductBtn = event.target.closest("[data-list-product]");
    if (listProductBtn) {
      const productId = Number(listProductBtn.dataset.listProduct);
      getAll("products").then((products) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return;
        product.status = "listed";
        product.updated_at = new Date().toISOString();
        putItem("products", product).then(renderLibrary);
      });
      return;
    }

    const productUrlBtn = event.target.closest("[data-product-url]");
    if (productUrlBtn) {
      const productId = Number(productUrlBtn.dataset.productUrl);
      getAll("products").then((products) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return;
        const url = prompt("粘贴商品链接", product.product_url || "");
        if (url === null) return;
        product.product_url = url.trim();
        product.updated_at = new Date().toISOString();
        putItem("products", product).then(renderLibrary);
      });
      return;
    }

    const noteProductBtn = event.target.closest("[data-note-product]");
    if (noteProductBtn) {
      const productId = Number(noteProductBtn.dataset.noteProduct);
      getAll("products").then((products) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return;
        const note = prompt("填写备注", product.note || "");
        if (note === null) return;
        product.note = note;
        product.updated_at = new Date().toISOString();
        putItem("products", product).then(renderLibrary);
      });
      return;
    }

    const deleteProductBtn = event.target.closest("[data-delete-product]");
    if (deleteProductBtn) {
      if (!confirm("确认删除这个产品吗？")) return;
      deleteItem("products", Number(deleteProductBtn.dataset.deleteProduct)).then(renderLibrary);
      return;
    }

    const viewBtn = event.target.closest("[data-view-shop]");
    if (viewBtn) {
      showLastRecognition(Number(viewBtn.dataset.viewShop));
      return;
    }

    const noteBtn = event.target.closest("[data-note-shop]");
    if (noteBtn) {
      const shopId = Number(noteBtn.dataset.noteShop);
      getShop(shopId).then((shop) => {
        if (!shop) return;
        const note = prompt("填写备注（可留空）", shop.note || "");
        if (note === null) return;
        shop.note = note;
        const category = prompt("填写分类标签（可留空）", shop.category || "");
        if (category !== null) {
          shop.category = category;
        }
        shop.updated_at = new Date().toISOString();
        putItem("shops", shop).then(renderAll);
      });
      return;
    }

    const restoreBtn = event.target.closest("[data-restore-shop]");
    if (restoreBtn) {
      const shopId = Number(restoreBtn.dataset.restoreShop);
      getShop(shopId).then((shop) => {
        if (!shop) return;
        shop.status = "candidate";
        shop.updated_at = new Date().toISOString();
        putItem("shops", shop).then(renderAll);
      });
      return;
    }

    const deleteShopBtn = event.target.closest("[data-delete-shop]");
    if (deleteShopBtn) {
      if (!confirm("确认删除这家店铺及其全部截图、识别记录和产品吗？")) return;
      deleteShop(Number(deleteShopBtn.dataset.deleteShop)).then(renderAll);
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
