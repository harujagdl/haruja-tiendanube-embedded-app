import process from "process";
import admin from "firebase-admin";

const ADMIN_COLLECTION = "HarujaPrendas_2025_admin";
const BATCH_LIMIT = 450;

const parseBoolean = (value, defaultValue = false) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const parseArgs = () => {
  const result = { storeId: "", dryRun: undefined };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry" || arg === "--dry-run" || arg === "--dryRun") {
      result.dryRun = "true";
      continue;
    }
    if (arg.startsWith("--storeId=")) {
      result.storeId = arg.split("=")[1] || "";
      continue;
    }
    if (arg.startsWith("--dry=") || arg.startsWith("--dry-run=") || arg.startsWith("--dryRun=")) {
      result.dryRun = arg.split("=")[1];
    }
  }
  return result;
};

const loadServiceAccount = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GCP_SA_KEY;
  if (!raw) {
    throw new Error("Falta FIREBASE_SERVICE_ACCOUNT_JSON o GCP_SA_KEY en env");
  }
  return JSON.parse(raw);
};

const initFirestore = () => {
  if (!process.env.FIREBASE_PROJECT_ID) {
    throw new Error("Falta FIREBASE_PROJECT_ID en env");
  }
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(loadServiceAccount()),
      projectId: process.env.FIREBASE_PROJECT_ID,
    });
  }
  return admin.firestore();
};

function normalizeCodigo(val) {
  return String(val ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .replace(/\//g, "-");
}

function getVariantStock(variant) {
  // 1) Si trae inventory_levels, sumar cantidades
  const levels = variant?.inventory_levels;
  if (Array.isArray(levels) && levels.length) {
    let sum = 0;
    for (const lvl of levels) {
      const q = Number(lvl?.quantity);
      if (!Number.isNaN(q)) sum += q;
    }
    return sum;
  }

  // 2) Fallback a variant.stock (puede venir "" para infinito)
  const s = variant?.stock;

  // stock infinito (""), tratamos como null para no mentir
  if (s === "") return null;
  if (s === null || s === undefined) return null;

  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return n;
}


const tnHeaders = ({ accessToken, apiVersion }) => ({
  Authentication: `bearer ${accessToken}`,
  "User-Agent": "Haruja (harujagdl@gmail.com)",
  "Content-Type": "application/json",
  "X-Api-Version": apiVersion,
});

const resolveTiendanubeCredentials = async (db, storeIdRaw) => {
  const storeId = String(storeIdRaw || "").trim();
  if (!storeId) throw new Error("Debes indicar --storeId=XXXX");

  let accessToken = "";
  const snapNew = await db.collection("tiendanubeStores").doc(storeId).get();
  if (snapNew.exists) {
    const data = snapNew.data() || {};
    accessToken = String(data.access_token || data.accessToken || "").trim();
  }

  if (!accessToken) {
    const snapOld = await db.collection("tn_stores").doc(storeId).get();
    if (snapOld.exists) {
      const data = snapOld.data() || {};
      accessToken = String(data.access_token || data.accessToken || "").trim();
    }
  }

  if (!accessToken) {
    const envKey = `TIENDANUBE_ACCESS_TOKEN_${storeId}`;
    accessToken = String(process.env[envKey] || process.env.TIENDANUBE_ACCESS_TOKEN || "").trim();
  }

  if (!accessToken) {
    throw new Error("No encontré access token para Tiendanube en tiendanubeStores, tn_stores ni env");
  }

  const apiVersion = String(process.env.TIENDANUBE_API_VERSION || "2024-04").trim();
  return { storeId, accessToken, apiVersion };
};

const fetchProductById = async ({ storeId, accessToken, apiVersion, productId }) => {
  const url = `https://api.tiendanube.com/v1/${encodeURIComponent(storeId)}/products/${encodeURIComponent(productId)}`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authentication: `bearer ${accessToken}`,
      "User-Agent": "Haruja (harujagdl@gmail.com)",
      "Content-Type": "application/json",
      "X-Api-Version": apiVersion,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Error Tiendanube productById (${response.status}) id=${productId}: ${body || "sin detalle"}`);
  }
  return await response.json();
};

const fetchAllSkuStocks = async ({ storeId, accessToken, apiVersion }) => {
  const skuStockMap = new Map();
  let page = 1;
  const perPage = 200;
  const CONCURRENCY = 8;

  while (true) {
    const url = new URL(`https://api.tiendanube.com/v1/${encodeURIComponent(storeId)}/products`);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", String(perPage));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: tnHeaders({ accessToken, apiVersion }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Error Tiendanube products (${response.status}): ${body || "sin detalle"}`);
    }

    const products = await response.json();
    if (!Array.isArray(products) || !products.length) break;

    const hasInlineVariants = products.some((p) => Array.isArray(p?.variants) && p.variants.length);

    if (hasInlineVariants) {
      for (const product of products) {
        const variants = Array.isArray(product?.variants) ? product.variants : [];
        for (const variant of variants) {
          const sku = normalizeCodigo(variant?.sku);
          const stock = getVariantStock(variant);
          if (!sku || stock === null) continue;
          skuStockMap.set(sku, stock);
        }
      }
    } else {
      const ids = products.map((p) => p?.id).filter(Boolean);

      for (let i = 0; i < ids.length; i += CONCURRENCY) {
        const chunk = ids.slice(i, i + CONCURRENCY);

        const detailed = await Promise.all(
          chunk.map((productId) =>
            fetchProductById({ storeId, accessToken, apiVersion, productId }).catch((e) => {
              console.log("WARN productById failed:", productId, e?.message || e);
              return null;
            }),
          ),
        );

        for (const product of detailed) {
          if (!product) continue;
          const variants = Array.isArray(product?.variants) ? product.variants : [];
          for (const variant of variants) {
            const sku = normalizeCodigo(variant?.sku);
            const stock = getVariantStock(variant);
            if (!sku || stock === null) continue;
            skuStockMap.set(sku, stock);
          }
        }
      }
    }

    if (products.length < perPage) break;
    page += 1;
  }

  return skuStockMap;
};

const findAdminDocBySku = async (col, sku) => {
  const skuNorm = normalizeCodigo(sku);

  let snap = await col.where("codigo", "==", skuNorm).limit(1).get();

  if (snap.empty) {
    const alt = skuNorm.replace(/-/g, "/");
    snap = await col.where("codigo", "==", alt).limit(1).get();
  }

  if (snap.empty) return null;
  return snap.docs[0].ref;
};

const main = async () => {
  const args = parseArgs();
  const dryRun = parseBoolean(process.env.DRY_RUN ?? args.dryRun ?? "false", false);
  const db = initFirestore();
  const { storeId, accessToken, apiVersion } = await resolveTiendanubeCredentials(db, args.storeId || process.env.TIENDANUBE_STORE_ID);

  const skuStockMap = await fetchAllSkuStocks({ storeId, accessToken, apiVersion });
  console.log(`SKUs encontrados en Tiendanube: ${skuStockMap.size}`);
  console.log("DEBUG skuStockMap size:", skuStockMap.size);
  console.log("DEBUG first 10 SKUs:", Array.from(skuStockMap.keys()).slice(0, 10));
  console.log("DEBUG first 10 stocks:", Array.from(skuStockMap.values()).slice(0, 10));

  const col = db.collection(ADMIN_COLLECTION);

  const updates = [];
  let totalSkusTiendanube = 0;
  let totalSyncedWithTiendanube = 0;
  let totalNotFound = 0;

  for (const [sku, stock] of skuStockMap.entries()) {
    totalSkusTiendanube += 1;

    const docRef = await findAdminDocBySku(col, sku);
    if (!docRef) {
      totalNotFound += 1;
      console.log("SKU no encontrado:", sku);
      continue;
    }

    const qtyAvailable = typeof stock === "number" ? stock : null;
    const disponibilidad = qtyAvailable > 0 ? "Disponible" : "No disponible";
    const statusCanon = qtyAvailable > 0 ? "Disponible" : "Vendido";

    updates.push({
      ref: docRef,
      payload: {
        qtyAvailable,
        disponibilidad,
        disponibilidadCanon: disponibilidad,
        status: statusCanon,
        statusCanon,
        inventorySource: "tiendanube",
        updatedAt: new Date().toISOString(),
      },
    });

    totalSyncedWithTiendanube += 1;
  }

  console.log(`Colección admin: ${ADMIN_COLLECTION}`);
  console.log(`Total SKUs Tiendanube: ${totalSkusTiendanube}`);
  console.log(`Total sincronizados con Tiendanube: ${totalSyncedWithTiendanube}`);
  console.log(`Total SKUs no encontrados en Firestore: ${totalNotFound}`);
  console.log(`Documentos a escribir: ${updates.length}`);

  if (dryRun) {
    console.log("DRY_RUN=true → no se escribirá en Firestore.");
    updates.slice(0, 20).forEach((item, index) => {
      console.log(`${index + 1}. ${item.ref.id} -> ${JSON.stringify(item.payload)}`);
    });
    return;
  }

  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach((item) => {
      batch.set(item.ref, item.payload, { merge: true });
    });

    await batch.commit();
    written += chunk.length;
    console.log(`✔ Batch ${Math.floor(i / BATCH_LIMIT) + 1}: ${chunk.length} docs`);
  }

  console.log(`✔ Total escritos: ${written}`);
};

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
