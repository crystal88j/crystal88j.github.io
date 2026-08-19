const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const DB_NAME = "xhs-selection-pwa";
const DB_VERSION = 1;
let dbPromise = null;
let workerPromise = null;
let shopTab = "candidate";

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

async function pruneShopSnapshots(shopId) {
  const snaps = await getShopSnapshots(shopId);
  const excess = snaps.length - 2;
  for (const snap of snaps.slice(0, excess)) {
    await deleteItem("shop_snapshots", snap.id);
  }
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

function shopCompareStatus(shop, snaps) {
  const ordered = [...snaps].sort(
    (a, b) => Date.parse(a.snapshot_at) - Date.parse(b.snapshot_at)
  );
  const latest = ordered[ordered.length - 1] || null;
  const needsCompare =
    ordered.length >= 2 &&
    (!shop.last_compared_at ||
      (latest && Date.parse(shop.last_compared_at) < Date.parse(latest.snapshot_at)));
  return { needsCompare, latest };
}

async function selectTasks() {
  const shops = (await getAll("shops")).filter((shop) => shop.status !== "excluded");
  const now = Date.now();
  const recapture = [];
  const firsts = [];
  const compares = [];

  for (const shop of shops) {
    const snaps = await getShopSnapshots(shop.id);
    const last = snaps[snaps.length - 1] || null;
    if (!last) {
      firsts.push({ shop, reason: "新店，尚未截图" });
    } else if (last.stage === "first") {
      if (now - Date.parse(last.snapshot_at) >= 20 * 60 * 60 * 1000) {
        recapture.push({ shop, reason: "24小时回读", task_type: "recapture" });
      }
    } else if (now - Date.parse(last.snapshot_at) >= 3 * 24 * 60 * 60 * 1000) {
      firsts.push({ shop, reason: "轮换复看", task_type: "first" });
    }
    const compareStatus = shopCompareStatus(shop, snaps);
    if (compareStatus.needsCompare) {
      compares.push({ shop, reason: "待对比", task_type: "compare" });
    }
  }

  recapture.sort(
    (a, b) => Date.parse(b.shop.last_seen_at || 0) - Date.parse(a.shop.last_seen_at || 0)
  );
  firsts.sort((a, b) => (a.shop.seen_count || 0) - (b.shop.seen_count || 0));

  return [...compares.slice(0, 10), ...recapture.slice(0, 10), ...firsts.slice(0, 10)].slice(0, 20);
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

function prepareImageForOcr(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const maxWidth = 1000;
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob);
          else reject(new Error("图片处理失败"));
        },
        "image/jpeg",
        0.85
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("图片读取失败"));
    };
    img.src = url;
  });
}

async function recognizeImage(file) {
  const prepared = await prepareImageForOcr(file);
  const worker = await getOcrWorker();
  const objectUrl = URL.createObjectURL(prepared);
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

async function reprocessSnapshot(snap) {
  if ((snap.parsedProducts || []).length > 0) return false;
  let file = null;
  if (snap.imageData) {
    file = new Blob([snap.imageData], { type: snap.imageMime || "image/*" });
  } else if (snap.imageBlob) {
    file = snap.imageBlob;
  }
  if (!file) return false;
  const { text, items } = await recognizeImage(file);
  snap.ocr_lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  snap.parsedProducts = parseProductsFromItems(items);
  await putItem("shop_snapshots", snap);
  return true;
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

  toast("正在保存截图");
  $("#header-status").textContent = "保存中";
  try {
    const imageData = await file.arrayBuffer();
    const existingShop = await getShop(shopId);
    const needShopName =
      !existingShop ||
      !existingShop.title ||
      existingShop.title === "未命名店铺" ||
      existingShop.title.startsWith("未命名");
    let lines = [];
    let items = [];
    let parsedProducts = [];
    if (needShopName) {
      toast("正在识别店铺名，请稍候");
      const result = await recognizeImage(file);
      items = result.items;
      lines = result.text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      parsedProducts = parseProductsFromItems(items);
    }
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
    await pruneShopSnapshots(shopId);
    const shop = await getShop(shopId);
    if (shop) {
      if (needShopName) {
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
    toast(needShopName ? "截图已保存，并识别店铺名" : "截图已保存");
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
    snap.imageData = await file.arrayBuffer();
    snap.imageMime = file.type || "image/*";
    snap.ocr_lines = [];
    snap.parsedProducts = [];
    snap.snapshot_at = new Date().toISOString();
    await putItem("shop_snapshots", snap);
    await pruneShopSnapshots(snap.shop_id);
    toast("截图已替换");
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
        <button class="ghost" data-note-shop="${shop.id}">备注/分类</button>
        ${shop.is_original || shop.status === "original"
          ? `<button class="ghost" data-restore-shop="${shop.id}">恢复</button>`
          : `<button class="danger" data-original-shop="${shop.id}">原创</button>`}
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
        ${task.task_type === "compare" ? `<button data-compare-shop="${shop.id}">对比截图</button>` : ""}
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

function updateShopTabs() {
  $("#shop-tab-candidate")?.classList.toggle("active", shopTab === "candidate");
  $("#shop-tab-original")?.classList.toggle("active", shopTab === "original");
}

async function renderShops() {
  updateShopTabs();
  let shops = await getAll("shops");
  if (shopTab === "candidate") {
    shops = shops.filter((shop) => !shop.is_original && shop.status !== "original" && shop.status !== "excluded");
    $("#shop-pool-title").textContent = "候选店铺";
  } else {
    shops = shops.filter((shop) => shop.is_original || shop.status === "original");
    $("#shop-pool-title").textContent = "原创店铺";
  }
  const search = $("#shop-search").value.trim().toLowerCase();
  if (search) {
    shops = shops.filter(
      (shop) =>
        (shop.title || "").toLowerCase().includes(search) ||
        (shop.url || "").toLowerCase().includes(search)
    );
  }
  shops.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
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
  const search = $("#record-search").value.trim().toLowerCase();
  const visibleShops = search
    ? shops.filter(
        (shop) =>
          (shop.title || "").toLowerCase().includes(search) ||
          (shop.url || "").toLowerCase().includes(search)
      )
    : shops;
  const byShop = new Map();
  for (const snap of snaps) {
    if (!byShop.has(snap.shop_id)) byShop.set(snap.shop_id, []);
    byShop.get(snap.shop_id).push(snap);
  }
  const shopsWithRecords = [...byShop.keys()]
    .map((shopId) => visibleShops.find((shop) => shop.id === shopId))
    .filter(Boolean)
    .sort((a, b) => {
      const aLatest = byShop.get(a.id)[0].snapshot_at;
      const bLatest = byShop.get(b.id)[0].snapshot_at;
      return new Date(bLatest) - new Date(aLatest);
    });
  list.innerHTML = shopsWithRecords
    .map((shop) => {
      const items = byShop.get(shop.id);
      const compareStatus = shopCompareStatus(shop, items);
      return `
        <details class="item shop-record">
          <summary>
            <div class="item-title">${escapeHtml(shop.title || "未命名店铺")}</div>
            <div class="item-meta">${escapeHtml(shop.url)} · ${items.length} 条记录 · <span class="badge ${compareStatus.needsCompare ? "warn" : ""}">${compareStatus.needsCompare ? "待对比" : "已对比"}</span></div>
          </summary>
          <div class="item-actions">
            <button data-compare-shop="${shop.id}">对比最近两张</button>
          </div>
          ${items.map((snap) => snapshotCard(snap, shop)).join("")}
        </details>`;
    })
    .join("");
}

let compareShopId = null;

function snapshotImageUrl(snap) {
  if (snap.imageData) {
    return URL.createObjectURL(new Blob([snap.imageData], { type: snap.imageMime || "image/*" }));
  }
  if (snap.imageBlob) {
    return URL.createObjectURL(snap.imageBlob);
  }
  return "";
}

async function openCompare(shopId) {
  const snaps = await getShopSnapshots(shopId);
  if (snaps.length < 2) {
    toast("这家店还需要两张截图才能对比");
    return;
  }
  const shop = await getShop(shopId);
  compareShopId = shopId;
  $("#compare-title").textContent = `${shop?.title || "店铺"} · 最近两张`;
  const lastTwo = snaps.slice(-2);
  $("#compare-images").innerHTML = lastTwo
    .map(
      (snap, index) => `
        <div class="compare-item">
          <div class="badge">${index === 0 ? "较早截图" : "最新截图"}</div>
          <img src="${snapshotImageUrl(snap)}" alt="店铺截图对比">
        </div>`
    )
    .join("");
  $("#compare-product-panel").style.display = "none";
  $("#compare-overlay").style.display = "flex";
  $("#compare-scroll").scrollTop = 0;
}

function closeCompare() {
  $("#compare-overlay").style.display = "none";
  compareShopId = null;
}

function showComparePanel() {
  $("#compare-product-panel").style.display = "block";
}

function hideComparePanel() {
  $("#compare-product-panel").style.display = "none";
}

async function findProductByLink(shopId, link) {
  const products = await getAll("products");
  const normalize = (value) =>
    String(value || "")
      .trim()
      .replace(/^https?:\/\//i, "")
      .replace(/\/+$/, "")
      .toLowerCase();
  const target = normalize(link);
  return (
    products.find(
      (product) =>
        product.shop_id === shopId && normalize(product.product_url) === target
    ) || null
  );
}

function productFromForm(shopId, link, salesFirst, salesSecond, intervalDays, price, listed, category, note) {
  const now = new Date().toISOString();
  const diff = Number(salesSecond) - Number(salesFirst);
  const days = Number(intervalDays) > 0 ? Number(intervalDays) : 1;
  const dailySales = Math.round((diff / days) * 100) / 100;
  const isOriginal = category === "原创";
  return {
    shop_id: shopId,
    title: link,
    product_url: link,
    sales_t0: Number(salesFirst),
    sales_t1: Number(salesSecond),
    interval_days: Number(intervalDays),
    daily_sales: dailySales,
    price_t1: price,
    daily_gmv: price === null ? null : Math.round(dailySales * price * 100) / 100,
    status: listed ? "listed" : isOriginal ? "original" : "candidate",
    category,
    is_original: isOriginal,
    note,
    created_at: now,
    updated_at: now,
  };
}

async function saveCompareProduct() {
  if (!compareShopId) {
    toast("请先选择店铺");
    return;
  }
  const link = $("#compare-product-link").value.trim();
  const salesFirst = Number($("#compare-sales-first").value);
  const salesSecond = Number($("#compare-sales-second").value);
  const intervalDays = Number($("#compare-interval").value);
  if (!link) {
    toast("请填写产品链接");
    return;
  }
  if (Number.isNaN(salesFirst) || Number.isNaN(salesSecond) || Number.isNaN(intervalDays)) {
    toast("请填写第一次销量、第二次销量和间隔天数");
    return;
  }
  const existing = await findProductByLink(compareShopId, link);
  if (existing) {
    toast("该产品已录入，无需重复录入");
    return;
  }
  const priceValue = $("#compare-price").value.trim();
  const price = priceValue ? Number(priceValue) : null;
  const product = productFromForm(
    compareShopId,
    link,
    salesFirst,
    salesSecond,
    intervalDays,
    price,
    $("#compare-listed").checked,
    $("#compare-category").value,
    $("#compare-note").value.trim()
  );
  await addItem("products", product);
  $("#compare-product-link").value = "";
  $("#compare-sales-first").value = "";
  $("#compare-sales-second").value = "";
  $("#compare-interval").value = "";
  $("#compare-price").value = "";
  $("#compare-listed").checked = false;
  $("#compare-category").value = "整理";
  $("#compare-note").value = "";
  hideComparePanel();
  toast("产品已保存，对比页位置不变");
  renderLibrary();
}

async function renderManualShopSelect(selectedId) {
  const shops = (await getAll("shops")).filter((shop) => shop.status !== "excluded");
  const select = $("#manual-shop-select");
  select.innerHTML = shops
    .map((shop) => `<option value="${shop.id}">${escapeHtml(shop.title || shop.url)}</option>`)
    .join("");
  if (selectedId) select.value = selectedId;
}

async function addManualProduct() {
  const shopId = Number($("#manual-shop-select").value);
  if (!shopId) {
    toast("请先选择店铺");
    return;
  }
  const link = $("#manual-product-link").value.trim();
  const salesFirst = Number($("#manual-sales-first").value);
  const salesSecond = Number($("#manual-sales-second").value);
  const intervalDays = Number($("#manual-interval").value);
  if (
    !link ||
    Number.isNaN(salesFirst) ||
    Number.isNaN(salesSecond) ||
    Number.isNaN(intervalDays)
  ) {
    toast("请填写产品链接、两次销量和间隔天数");
    return;
  }
  const existing = await findProductByLink(shopId, link);
  if (existing) {
    toast("该产品已录入，无需重复录入");
    return;
  }
  const priceValue = $("#manual-price").value.trim();
  const price = priceValue ? Number(priceValue) : null;
  const product = productFromForm(
    shopId,
    link,
    salesFirst,
    salesSecond,
    intervalDays,
    price,
    $("#manual-listed").checked,
    $("#manual-original").checked,
    $("#manual-note").value.trim()
  );
  await addItem("products", product);
  $("#manual-product-link").value = "";
  $("#manual-sales-first").value = "";
  $("#manual-sales-second").value = "";
  $("#manual-interval").value = "";
  $("#manual-price").value = "";
  $("#manual-listed").checked = false;
  $("#manual-original").checked = false;
  $("#manual-note").value = "";
  toast("产品已添加");
  renderLibrary();
}

async function renderLibrary() {
  const products = await getAll("products");
  const shops = await getAll("shops");
  const filter = $("#library-filter").value;
  const minDaily = Number($("#daily-sales-filter").value || 0);
  const shopQuery = $("#shop-filter").value.trim().toLowerCase();
  const visible = products.filter((product) => {
    const shop = shops.find((s) => s.id === product.shop_id) || {};
    if (shopQuery && !(shop.title || "").toLowerCase().includes(shopQuery)) return false;
    if ((product.daily_sales ?? 0) < minDaily) return false;
    if (filter === "pending") {
      return !product.is_original && product.status !== "original" && product.status !== "listed" && product.status !== "discarded";
    }
    if (filter === "listed") return product.status === "listed";
    if (filter === "original") return product.is_original || product.status === "original" || product.status === "discarded";
    return true;
  });
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
        original: "原创",
        discarded: "已删除",
      }[product.status] || product.status;
      return `
        <div class="item">
          <div class="badge ${product.status === "quality" ? "warn" : ""}">${escapeHtml(statusLabel)}</div>
          <div class="item-title">${escapeHtml(product.title)}</div>
          <div class="item-meta">店铺：${escapeHtml(shop.title || "店铺")} · <a href="${escapeHtml(shop.url || "#")}" target="_blank" rel="noopener">打开店铺</a></div>
          <div class="item-meta">类别：${escapeHtml(product.category || "整理")} · 第一次 ${escapeHtml(product.sales_t0 ?? "-")} · 第二次 ${escapeHtml(product.sales_t1 ?? "-")} · 间隔 ${escapeHtml(product.interval_days || 1)} 天 · 日均 ${escapeHtml(product.daily_sales ?? "-")} · 单价 ${escapeHtml(product.price_t1 ?? "-")} · GMV ${escapeHtml(product.daily_gmv ?? "-")}</div>
          <div class="item-meta">${product.product_url ? `<button class="ghost" data-open-product="${product.id}">打开商品链接</button>` : "暂无商品链接"}</div>
          <div class="item-meta">备注：${escapeHtml(product.note || "无")}</div>
          <div class="item-actions">
            <button data-list-product="${product.id}">标记已上架</button>
            ${product.is_original || product.status === "original" || product.status === "discarded"
              ? `<button class="ghost" data-restore-product="${product.id}">恢复</button>`
              : ""}
            <button class="ghost" data-product-url="${product.id}">填写商品链接</button>
            <button class="ghost" data-edit-product="${product.id}">编辑</button>
            <button class="ghost" data-note-product="${product.id}">备注</button>
            <button class="danger" data-delete-product="${product.id}">删除</button>
          </div>
        </div>`;
    })
    .join("");
}

async function renderAll() {
  await Promise.all([
    renderTasks(),
    renderShops(),
    renderRecords(),
    renderLibrary(),
  ]);
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
    rows.push(["产品库更新时间", "店铺", "商品", "日均销量", "间隔天数", "第一次销量", "第二次销量", "单价", "日GMV", "状态", "是否原创", "备注"]);
    for (const product of products) {
      const shop = shops.find((s) => s.id === product.shop_id) || {};
      rows.push([
        product.updated_at ? new Date(product.updated_at).toLocaleString() : "",
        shop.title || "",
        product.title || "",
        product.daily_sales ?? "",
        product.interval_days || "",
        product.sales_t0 ?? "",
        product.sales_t1 ?? "",
        product.price_t1 ?? "",
        product.daily_gmv ?? "",
        product.status || "",
        product.is_original ? "是" : "否",
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
  $("#library-filter").addEventListener("change", renderLibrary);
  $("#daily-sales-filter").addEventListener("input", renderLibrary);
  $("#shop-filter").addEventListener("input", renderLibrary);
  $("#shop-search").addEventListener("input", renderShops);
  $("#shop-tab-candidate").addEventListener("click", () => {
    shopTab = "candidate";
    updateShopTabs();
    renderShops();
  });
  $("#shop-tab-original").addEventListener("click", () => {
    shopTab = "original";
    updateShopTabs();
    renderShops();
  });
  $("#record-search").addEventListener("input", renderRecords);
  $("#compare-close").addEventListener("click", closeCompare);
  $("#compare-done").addEventListener("click", async () => {
    if (!compareShopId) return;
    const shop = await getShop(compareShopId);
    if (!shop) return;
    shop.last_compared_at = new Date().toISOString();
    await putItem("shops", shop);
    toast("已标记对比完成");
    closeCompare();
    renderAll();
  });
  $("#compare-add-product").addEventListener("click", showComparePanel);
  $("#compare-cancel-product").addEventListener("click", hideComparePanel);
  $("#compare-save-product").addEventListener("click", () => {
    saveCompareProduct().catch((error) => toast(`保存失败：${error.message}`));
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

    const compareBtn = event.target.closest("[data-compare-shop]");
    if (compareBtn) {
      openCompare(Number(compareBtn.dataset.compareShop));
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

    const openProductBtn = event.target.closest("[data-open-product]");
    if (openProductBtn) {
      const productId = Number(openProductBtn.dataset.openProduct);
      getAll("products").then((products) => {
        const product = products.find((p) => p.id === productId);
        if (!product || !product.product_url) {
          toast("该产品没有商品链接");
          return;
        }
        window.open(product.product_url, "_blank");
      });
      return;
    }

    const editProductBtn = event.target.closest("[data-edit-product]");
    if (editProductBtn) {
      const productId = Number(editProductBtn.dataset.editProduct);
      getAll("products").then(async (products) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return;
        const first = prompt("第一次累计销量", product.sales_t0 ?? "");
        if (first === null) return;
        const second = prompt("第二次累计销量", product.sales_t1 ?? "");
        if (second === null) return;
        const interval = prompt("间隔天数", product.interval_days ?? 1);
        if (interval === null) return;
        const price = prompt("单价（可留空）", product.price_t1 ?? "");
        if (price === null) return;
        const link = prompt("产品链接", product.product_url || "");
        if (link === null) return;
        const statusChoice = prompt("状态：未上架/已上架", product.status === "listed" ? "已上架" : "未上架");
        if (statusChoice === null) return;
        const categoryChoice = prompt(
          "类别：整理/原创",
          product.category || (product.is_original ? "原创" : "整理")
        );
        if (categoryChoice === null) return;
        const note = prompt("备注（可留空）", product.note || "");
        if (note === null) return;
        const firstNumber = Number(first);
        const secondNumber = Number(second);
        const intervalNumber = Number(interval);
        if (Number.isNaN(firstNumber) || Number.isNaN(secondNumber) || Number.isNaN(intervalNumber)) {
          toast("销量和间隔天数格式不正确");
          return;
        }
        const dailyNumber =
          Math.round(((secondNumber - firstNumber) / Math.max(intervalNumber, 1)) * 100) / 100;
        const priceNumber = price ? Number(price) : null;
        product.sales_t0 = firstNumber;
        product.sales_t1 = secondNumber;
        product.interval_days = intervalNumber;
        product.daily_sales = dailyNumber;
        product.price_t1 = priceNumber;
        product.product_url = link.trim();
        product.title = link.trim();
        product.status =
          statusChoice === "已上架"
            ? "listed"
            : categoryChoice === "原创"
              ? "original"
              : "candidate";
        product.is_original = categoryChoice === "原创";
        product.category = categoryChoice === "原创" ? "原创" : "整理";
        product.note = note;
        product.daily_gmv =
          priceNumber === null ? null : Math.round(dailyNumber * priceNumber * 100) / 100;
        product.updated_at = new Date().toISOString();
        await putItem("products", product);
        toast("产品已更新");
        renderLibrary();
      });
      return;
    }

    const restoreProductBtn = event.target.closest("[data-restore-product]");
    if (restoreProductBtn) {
      const productId = Number(restoreProductBtn.dataset.restoreProduct);
      getAll("products").then((products) => {
        const product = products.find((p) => p.id === productId);
        if (!product) return;
        product.status = "candidate";
        product.is_original = false;
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
        shop.is_original = false;
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

    const originalBtn = event.target.closest("[data-original-shop]");
    if (originalBtn) {
      if (!confirm("确认标记为原创店铺吗？标记后会转入原创店铺库。")) return;
      const shopId = Number(originalBtn.dataset.originalShop);
      getShop(shopId).then((shop) => {
        if (!shop) return;
        shop.status = "original";
        shop.is_original = true;
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
