const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentWritten} = require("firebase-functions/v2/firestore");
const {setGlobalOptions} = require("firebase-functions/v2");
const {defineSecret} = require("firebase-functions/params");
const {admin, db} = require("./firebaseAdmin");
const {randomUUID} = require("crypto");
const {v4: uuidv4} = require("uuid");
const Busboy = require("busboy");
const XLSX = require("xlsx");
const puppeteer = require("puppeteer-core");
const chromium = require("@sparticuz/chromium");
const loyalty = require("./loyalty");


const PRENDAS_COLLECTION = "HarujaPrendas_2025";
const PRENDAS_PUBLIC_COLLECTION = "HarujaPrendas_2025_public";
const PRENDAS_ADMIN_COLLECTION = "HarujaPrendas_2025_admin";
const ADMIN_ALLOWLIST = new Set([
  "yair.tenorio.silva@gmail.com",
  "harujagdl@gmail.com",
  "harujagdl.ventas@gmail.com"
]);
const SEARCH_VERSION = 1;
const DEFAULT_BATCH_SIZE = 200;
const MIGRATE_MIN_BATCH_SIZE = 50;
const MIGRATE_MAX_BATCH_SIZE = 400;
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const ALLOWED_ORIGINS = new Set([
  "https://haruja-tiendanube.web.app",
  "https://haruja-tiendanube.firebaseapp.com",
  "https://haruja-panel.vercel.app",
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:3000"
]);
const LOYALTY_PUBLIC_UPDATE_ALLOWED_ORIGINS = new Set([
  "https://tiendanube.web.app",
  "https://haruja-tiendanube.web.app",
  "https://haruja-panel.vercel.app"
]);
const RUNTIME_OPTS = {
  memory: "1GiB",
  timeoutSeconds: 540
};

setGlobalOptions({
  region: "us-central1",
  memory: RUNTIME_OPTS.memory,
  timeoutSeconds: RUNTIME_OPTS.timeoutSeconds
});
const STOPWORDS = new Set([
  "de",
  "la",
  "el",
  "los",
  "las",
  "y",
  "o",
  "en",
  "para",
  "con",
  "sin",
  "un",
  "una"
]);
const adminSessions = new Map();
const ORDER_SELLER_COLLECTION = "order_seller";

/**
 * =========================
 *  TIENDANUBE OAUTH (APP PRIVADA - HARUJA)
 * =========================
 * Requiere secrets en Firebase Secret Manager:
 * - TIENDANUBE_CLIENT_ID  (App ID)
 * - TIENDANUBE_CLIENT_SECRET
 *
 * Configura en Partners (URLs):
 * - URL para redirigir después de la instalación:
 *   https://us-central1-haruja-tiendanube.cloudfunctions.net/tnAuthCallback
 */
const TIENDANUBE_CLIENT_ID = defineSecret("TIENDANUBE_CLIENT_ID");
const TIENDANUBE_CLIENT_SECRET = defineSecret("TIENDANUBE_CLIENT_SECRET");

function getProjectId_() {
  try {
    if (process.env.GCLOUD_PROJECT) return String(process.env.GCLOUD_PROJECT);
    if (process.env.GCP_PROJECT) return String(process.env.GCP_PROJECT);
    if (process.env.FIREBASE_CONFIG) {
      const cfg = JSON.parse(String(process.env.FIREBASE_CONFIG));
      if (cfg && cfg.projectId) return String(cfg.projectId);
    }
  } catch (_e) {}
  return "haruja-tiendanube";
}

function getTiendanubeRedirectUri_() {
  const projectId = getProjectId_();
  return `https://us-central1-${projectId}.cloudfunctions.net/tnAuthCallback`;
}

/**
 * GET /tnAuthStart
 * Inicia autorización. Para app privada no pedimos store_id;
 * Tiendanube manda store_id en el callback.
 */
exports.tnAuthStart = onRequest(
  { ...RUNTIME_OPTS, secrets: [TIENDANUBE_CLIENT_ID] },
  async (req, res) => {
    try {
      const clientId = String(TIENDANUBE_CLIENT_ID.value() || "").trim();
      if (!clientId) {
        return res.status(500).send("Missing TIENDANUBE_CLIENT_ID secret.");
      }

      const redirectUri = getTiendanubeRedirectUri_();
      const authUrl =
        `https://www.tiendanube.com/apps/${encodeURIComponent(clientId)}/authorize` +
        `?redirect_uri=${encodeURIComponent(redirectUri)}`;

      return res.redirect(authUrl);
    } catch (err) {
      console.error("tnAuthStart error", err);
      return res.status(500).send("Error iniciando OAuth.");
    }
  }
);

/**
 * GET /tnAuthCallback?code=...&store_id=...
 * Intercambia code -> access_token y lo guarda en Firestore:
 * tn_stores/{storeId}
 */
exports.tnAuthCallback = onRequest(
  { ...RUNTIME_OPTS, secrets: [TIENDANUBE_CLIENT_ID, TIENDANUBE_CLIENT_SECRET] },
  async (req, res) => {
    try {
      const clientId = String(TIENDANUBE_CLIENT_ID.value() || "").trim();
      const clientSecret = String(TIENDANUBE_CLIENT_SECRET.value() || "").trim();
      if (!clientId || !clientSecret) {
        return res.status(500).send("Missing TIENDANUBE_CLIENT_ID / TIENDANUBE_CLIENT_SECRET secrets.");
      }

      const code = String(req.query.code || "").trim();
      // En apps privadas, Tiendanube a veces NO envía store_id en el callback.
      // Si viene, lo usamos; si no, lo obtendremos del response del token exchange.
      const storeIdFromQuery = String(req.query.store_id || "").trim();
      if (!code) {
        return res.status(400).send("Missing code.");
      }

      const redirectUri = getTiendanubeRedirectUri_();

      const tokenRes = await fetch("https://www.tiendanube.com/apps/authorize/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: Number(clientId),
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
        }),
      });

      const payload = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !payload?.access_token) {
        console.error("tnAuthCallback token exchange failed", {status: tokenRes.status, payload});
        return res.status(400).json({ ok: false, error: payload || "Token exchange failed" });
      }

      const storeId = String(payload.store_id || storeIdFromQuery || "").trim();
      if (!storeId) {
        console.error("tnAuthCallback: store_id missing", {payloadKeys: Object.keys(payload || {})});
        return res.status(400).send("Missing store_id (no vino en callback ni en token response).");
      }

      await db.collection("tn_stores").doc(storeId).set(
        {
          storeId,
          access_token: payload.access_token,
          scope: payload.scope || null,
          token_type: payload.token_type || "bearer",
          user_id: payload.user_id ?? null,
          installedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      return res.status(200).send("✅ Tiendanube conectado. Ya puedes cerrar esta ventana.");
    } catch (err) {
      console.error("tnAuthCallback error", err);
      return res.status(500).send("Error procesando OAuth callback.");
    }
  }
);

const parseMonthRange = (monthInput = "") => {
  const raw = String(monthInput || "").trim();
  if (!/^\d{4}-\d{2}$/.test(raw)) {
    throw buildBadRequestError("Parámetro month inválido. Usa formato YYYY-MM.");
  }
  const [yearStr, monthStr] = raw.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw buildBadRequestError("Parámetro month inválido. Usa formato YYYY-MM.");
  }

  const start = new Date(Date.UTC(year, month - 1, 1, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, 1, 0, 0, 0));
  return {
    month: raw,
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
};

const _tnTokenCache = new Map();

/**
 * Obtiene access_token para Tiendanube.
 * Prioridad:
 *  1) Firestore: tn_stores/{storeId}.access_token (lo guarda tnAuthCallback)
 *  2) Variables de entorno: TIENDANUBE_ACCESS_TOKEN_{storeId} o TIENDANUBE_ACCESS_TOKEN
 */
const resolveTiendanubeCredentials = async (storeId) => {
  const normalizedStoreId = String(storeId || "").trim();
  if (!normalizedStoreId) {
    throw buildBadRequestError("Falta query param storeId.");
  }

  const now = Date.now();
  const cached = _tnTokenCache.get(normalizedStoreId);
  if (cached && cached.accessToken && cached.expiresAtMs > now) {
    const apiVersion = String(process.env.TIENDANUBE_API_VERSION || "2024-04").trim();
    return {storeId: normalizedStoreId, accessToken: cached.accessToken, apiVersion};
  }

  // 1) Firestore
  try {
    const snap = await db.collection("tn_stores").doc(normalizedStoreId).get();
    const token = snap.exists ? String(snap.data()?.access_token || "").trim() : "";
    if (token) {
      _tnTokenCache.set(normalizedStoreId, {accessToken: token, expiresAtMs: now + 5 * 60 * 1000});
      const apiVersion = String(process.env.TIENDANUBE_API_VERSION || "2024-04").trim();
      return {storeId: normalizedStoreId, accessToken: token, apiVersion};
    }
  } catch (e) {
    console.warn("resolveTiendanubeCredentials: no pude leer tn_stores", e);
  }

  // 2) Env vars (fallback)
  const envKey = `TIENDANUBE_ACCESS_TOKEN_${normalizedStoreId}`;
  const accessToken = String(process.env[envKey] || process.env.TIENDANUBE_ACCESS_TOKEN || "").trim();
  if (!accessToken) {
    throw buildBadRequestError(
      `No encontré access token para Tiendanube. Conecta la tienda (OAuth) o configura ${envKey} o TIENDANUBE_ACCESS_TOKEN.`,
      500
    );
  }

  _tnTokenCache.set(normalizedStoreId, {accessToken, expiresAtMs: now + 5 * 60 * 1000});
  const apiVersion = String(process.env.TIENDANUBE_API_VERSION || "2024-04").trim();
  return {storeId: normalizedStoreId, accessToken, apiVersion};
};

const normalizeMoneyAmount = (rawAmount, fallback = 0) => {
  const parsed = Number(rawAmount);
  if (Number.isFinite(parsed)) return parsed;
  return Number(fallback) || 0;
};

const fetchPaidOrdersFromTiendanube = async ({storeId, accessToken, apiVersion, startIso, endIso}) => {
  const orders = [];
  let page = 1;
  const perPage = 200;

  while (true) {
    const url = new URL(`https://api.tiendanube.com/v1/${storeId}/orders`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    url.searchParams.set("created_at_min", startIso);
    url.searchParams.set("created_at_max", endIso);
    url.searchParams.set("payment_status", "paid");

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authentication: `bearer ${accessToken}`,
        "User-Agent": "Haruja (harujagdl@gmail.com)",
        "Content-Type": "application/json",
        "X-Api-Version": apiVersion
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw buildBadRequestError(`Error Tiendanube (${response.status}): ${body || "sin detalle"}`, 502);
    }

    const payload = await response.json();
    if (!Array.isArray(payload) || !payload.length) break;

    for (const order of payload) {
      if (!order || order.payment_status !== "paid") continue;
      orders.push(order);
    }

    if (payload.length < perPage) break;
    page += 1;
  }

  return orders;
};

const mapSellerAssignments = async (orderIds = []) => {
  const assignments = new Map();
  if (!orderIds.length) return assignments;

  const chunks = [];
  for (let i = 0; i < orderIds.length; i += 30) {
    chunks.push(orderIds.slice(i, i + 30));
  }

  for (const chunk of chunks) {
    const snapshot = await db.collection(ORDER_SELLER_COLLECTION)
      .where(admin.firestore.FieldPath.documentId(), "in", chunk)
      .get();
    snapshot.forEach((doc) => {
      const data = doc.data() || {};
      const seller = String(data.seller || "").trim();
      if (seller) assignments.set(doc.id, seller);
    });
  }

  return assignments;
};

const buildSalesDataset = async ({storeId, month}) => {
  const {startIso, endIso} = parseMonthRange(month);
  const credentials = await resolveTiendanubeCredentials(storeId);
  const paidOrders = await fetchPaidOrdersFromTiendanube({...credentials, startIso, endIso});
  const orderIds = paidOrders.map((order) => String(order.id || "").trim()).filter(Boolean);
  const assignmentMap = await mapSellerAssignments(orderIds);

  const totalsBySeller = {};
  let totalMes = 0;
  let totalSinAsignar = 0;

  const orders = paidOrders.map((order) => {
    const orderId = String(order.id || "").trim();
    const total = normalizeMoneyAmount(order.total, order.total_paid);
    const seller = assignmentMap.get(orderId) || "";
    const customerName = [order?.customer?.name, order?.customer?.last_name]
      .filter((value) => !!String(value || "").trim())
      .join(" ")
      .trim() || String(order?.customer?.name || "Cliente");

    totalMes += total;
    if (seller) {
      totalsBySeller[seller] = (totalsBySeller[seller] || 0) + total;
    } else {
      totalSinAsignar += total;
    }

    return {
      orderId,
      fecha: String(order.completed_at || order.created_at || ""),
      cliente: customerName,
      totalPagado: Number(total.toFixed(2)),
      estado: String(order.payment_status || ""),
      seller
    };
  });

  const totalPorVendedora = Object.entries(totalsBySeller)
    .sort((a, b) => b[1] - a[1])
    .map(([seller, total]) => ({seller, total: Number(total.toFixed(2))}));

  return {
    month,
    storeId: String(storeId),
    totalMes: Number(totalMes.toFixed(2)),
    totalSinAsignar: Number(totalSinAsignar.toFixed(2)),
    totalPorVendedora,
    orders
  };
};

const toCsvEscaped = (value) => {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
};

const safeDocId = (val) =>
  String(val ?? "")
    .trim()
    .toUpperCase()
    .replaceAll("/", "__");
const normalizeCodigo = (val) => String(val ?? "").trim().toUpperCase();

const normalizeHeaderKey = (value) =>
  String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

const HEADER_ALIASES = {
  orden: ["orden", "order", "#", "no", "num", "secuencia", "seq", "seqnumber"],
  codigo: ["codigo", "código", "code", "sku"],
  costo: ["costo", "cost", "costo$"],
  precioConIva: ["precioconiva", "precio con iva", "pventa", "p.venta", "venta", "precioiva"],
  precio: ["precio", "price"],
  pVenta: ["pventa", "p.venta", "venta", "precioventa"],
  margen: ["margen", "markup", "margen%"],
  utilidad: ["utilidad", "profit"],
  descripcion: ["descripcion", "descripción", "producto", "nombre", "item"],
  tipo: ["tipo", "category", "categoria", "categoría"],
  color: ["color"],
  talla: ["talla", "size"],
  proveedor: ["proveedor", "brand", "marca"],
  status: ["status", "estado"],
  disponibilidad: ["disponibilidad", "stock"],
  fecha: ["fecha", "fechatexto", "fechaalta"],
};

const resolveColumnIndex = (headerMap, aliases = []) => {
  for (const alias of aliases) {
    const idx = headerMap.get(normalizeHeaderKey(alias));
    if (Number.isInteger(idx)) return idx;
  }
  return -1;
};

const getRowValue = (row, index) => {
  if (!Array.isArray(row) || index < 0) return "";
  return row[index];
};

const parseMultipartFile = (req, fieldName = "file") =>
  new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    if (!contentType.includes("multipart/form-data")) {
      return reject(new Error("Content-Type debe ser multipart/form-data."));
    }

    const bb = Busboy({
      headers: req.headers,
      limits: { fileSize: 10 * 1024 * 1024 } // 10MB
    });

    let fileBuffer = null;
    let fileBytes = 0;
    let filename = null;

    bb.on("file", (name, file, info) => {
      if (name !== fieldName) {
        file.resume();
        return;
      }

      filename = info?.filename || "upload.xlsx";
      const chunks = [];

      file.on("data", (data) => {
        chunks.push(data);
        fileBytes += data.length;
      });

      file.on("end", () => {
        fileBuffer = Buffer.concat(chunks);
      });
    });

    bb.on("error", reject);

    bb.on("finish", () => {
      if (!fileBuffer || fileBuffer.length === 0) {
        return reject(new Error("No se recibió archivo (campo 'file')."));
      }
      resolve({ buffer: fileBuffer, filename, fileBytes });
    });

    // 🔥 SIEMPRE usar rawBody en v2
    if (!req.rawBody) {
      return reject(new Error("rawBody no disponible."));
    }

    bb.end(req.rawBody);
  });

function applyCors(req, res) {
  const origin = req.get("origin");
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://haruja-tiendanube.web.app";
  res.set("Access-Control-Allow-Origin", allowOrigin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Password");
  res.set("Access-Control-Allow-Credentials", "true");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return true;
  }
  return false;
}

const toNumber = (v) => {
  if (!v) return null;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const numOrUndefined = (v) => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim().replace(/[,$\s]/g, "");
  if (!s) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
};

const firstNumber = (...values) => {
  for (const value of values) {
    const n = toNumber(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
};

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};

const getBearerToken = (authHeader = "") => {
  if (!authHeader.startsWith("Bearer ")) return "";
  return authHeader.slice(7).trim();
};

const requireAllowlistedAdmin = async (req) => {
  const idToken = getBearerToken(String(req.headers?.authorization || ""));
  if (!idToken) {
    throw new HttpsError(
      "unauthenticated",
      "Authorization Bearer token requerido."
    );
  }
  const decoded = await admin.auth().verifyIdToken(idToken);
  const email = String(decoded?.email || "").trim().toLowerCase();
  if (!ADMIN_ALLOWLIST.has(email)) {
    throw new HttpsError(
      "permission-denied",
      "Usuario no autorizado para importar."
    );
  }
  return {uid: decoded.uid, email};
};

const stripSensitive = (data = {}) => {
  const copy = {...data};
  delete copy.costo;
  delete copy.iva;
  delete copy.margen;
  delete copy.utilidad;
  return copy;
};

const toFixedNumber = (value, digits = 2) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
};

const round2 = (value) => toFixedNumber(value, 2);
const round1 = (value) => toFixedNumber(value, 1);

const resolveOrden = (data = {}) => {
  const orden = Number(data.orden ?? data.Orden);
  if (Number.isFinite(orden)) return orden;
  const seqNumber = Number(data.seqNumber ?? data.seq ?? data.secuencia);
  if (Number.isFinite(seqNumber)) return seqNumber;
  return null;
};

const resolvePVentaFromMaster = (data = {}) => {
  const pVenta = Number(data.pVenta);
  if (Number.isFinite(pVenta)) return toFixedNumber(pVenta);
  const precioConIva = Number(data.precioConIva ?? data.precioConIVA);
  if (Number.isFinite(precioConIva)) return toFixedNumber(precioConIva);
  return null;
};

const buildPublicPayloadFromMaster = (data = {}) => {
  const payload = {
    docId: data.docId ?? data.codigo ?? null,
    code: data.code ?? data.codigo ?? null,
    codigo: data.codigo ?? null,
    descripcion: data.descripcion ?? null,
    tipo: data.tipo ?? null,
    color: data.color ?? null,
    talla: data.talla ?? null,
    proveedor: data.proveedor ?? null,
    status: data.status ?? null,
    disponibilidad: data.disponibilidad ?? null,
    fecha: data.fecha ?? null,
    fechaTexto: data.fechaTexto ?? null,
    updatedAt: data.updatedAt ?? null,
    orden: toNumber(data.orden) ?? null,
    seqNumber: toNumber(data.seqNumber) ?? null,
    pVenta: resolvePVentaFromMaster(data),
    precio: toFixedNumber(data.precio),
    precioConIva: toFixedNumber(data.precioConIva ?? data.precioConIVA)
  };

  const orden = resolveOrden(data);
  if (Number.isFinite(orden)) {
    payload.orden = orden;
  }

  return payload;
};

function buildAdminPayloadFromMaster(masterData) {
  const costo = numOrUndefined(masterData.costo);
  const precioConIva = numOrUndefined(masterData.precioConIva ?? masterData.pVenta);
  const orden = numOrUndefined(masterData.orden ?? masterData.seqNumber);

  const utilidad =
    Number.isFinite(precioConIva) && Number.isFinite(costo)
      ? round2(precioConIva - costo)
      : null;

  const margen =
    Number.isFinite(costo) && costo > 0 && Number.isFinite(utilidad)
      ? round1((utilidad / costo) * 100)
      : null;

  return {
    ...buildPublicPayloadFromMaster(masterData),
    orden: Number.isFinite(orden) ? orden : null,
    costo: Number.isFinite(costo) ? costo : null,
    precioConIva: Number.isFinite(precioConIva) ? precioConIva : null,
    pVenta: Number.isFinite(precioConIva) ? precioConIva : null,
    utilidad: Number.isFinite(utilidad) ? utilidad : null,
    margen: Number.isFinite(margen) ? margen : null,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}

exports.splitPrendasToPublicAdmin = onRequest(RUNTIME_OPTS, async (req, res) => {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);
    const sourceCollection = String(req.body?.sourceCollection || PRENDAS_COLLECTION).trim() || PRENDAS_COLLECTION;
    const dryRunRaw = req.query?.dryRun ?? req.body?.dryRun;
    const dryRun = [true, "true", "1", 1].includes(dryRunRaw);
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
    const startAfter = String(req.body?.startAfter || "").trim();
    const requestedChunkSize = Number(req.body?.chunkSize ?? req.query?.chunkSize);
    const chunkSize = Number.isFinite(requestedChunkSize)
      ? Math.max(200, Math.min(400, Math.floor(requestedChunkSize)))
      : DEFAULT_BATCH_SIZE;

    let processed = 0;
    let writtenPublic = 0;
    let writtenAdmin = 0;
    let lastDocId = startAfter || null;
    const firstProcessedIds = [];
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      let baseQuery = db
        .collection(sourceCollection)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(chunkSize);

      if (cursor) {
        baseQuery = baseQuery.startAfter(cursor);
      } else if (startAfter) {
        baseQuery = baseQuery.startAfter(startAfter);
      }

      const snapshot = await baseQuery.get();
      if (snapshot.empty) break;

      const rows = limit > 0
        ? snapshot.docs.slice(0, Math.max(0, limit - processed))
        : snapshot.docs;
      if (rows.length === 0) break;

      const batch = db.batch();
      for (const docSnap of rows) {
        const payload = docSnap.data() || {};
        const docId = safeDocId(payload.docId || payload.codigo || docSnap.id);
        const publicData = buildPublicPayloadFromMaster(payload);
        const adminData = buildAdminPayloadFromMaster(payload);
        publicData.docId = docId;
        adminData.docId = docId;
        processed += 1;
        lastDocId = docSnap.id;
        if (firstProcessedIds.length < 3) firstProcessedIds.push(docSnap.id);

        if (!dryRun) {
          batch.set(db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId), publicData, {merge: true});
          batch.set(db.collection(PRENDAS_ADMIN_COLLECTION).doc(docId), adminData, {merge: true});
          writtenPublic += 1;
          writtenAdmin += 1;
        }
      }

      if (!dryRun) {
        await batch.commit();
      }

      console.info("splitPrendasToPublicAdmin chunk", {
        by: adminSession.email,
        dryRun,
        processed,
        writtenPublic,
        writtenAdmin,
        lastDocId
      });

      cursor = rows[rows.length - 1];
      hasMore = rows.length === chunkSize;
      if (limit > 0 && processed >= limit) {
        hasMore = false;
      }
    }

    console.info("splitPrendasToPublicAdmin completed", {
      by: adminSession.email,
      sourceCollection,
      dryRun,
      processed,
      writtenPublic,
      writtenAdmin,
      firstProcessedIds,
      lastDocId
    });

    return res.status(200).json({
      ok: true,
      sourceCollection,
      processed,
      writtenPublic,
      writtenAdmin,
      firstProcessedIds,
      lastDocId
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      return res.status(error.httpErrorCode.status).json({ok: false, error: error.message});
    }
    console.error("splitPrendasToPublicAdmin failed", error);
    return res.status(500).json({ok: false, error: String(error)});
  }
});

exports.syncPublicPrendas2025 = onRequest(RUNTIME_OPTS, async (req, res) => {
  try {
    if (applyCors(req, res)) return;
    const snapshot = await db.collection(PRENDAS_COLLECTION).get();
    const total = snapshot.size;

    if (total === 0) {
      return res.status(200).json({ok: true, total: 0, message: "SRC empty"});
    }

    let batch = db.batch();
    let batchCount = 0;
    let written = 0;

    for (const docSnap of snapshot.docs) {
      const data = stripSensitive(docSnap.data());
      const destRef = db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docSnap.id);

      batch.set(destRef, data, {merge: true});
      batchCount += 1;
      written += 1;

      if (batchCount >= 450) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    }

    if (batchCount > 0) {
      await batch.commit();
    }

    return res.status(200).json({
      ok: true,
      total,
      written,
      dest: PRENDAS_PUBLIC_COLLECTION
    });
  } catch (error) {
    console.error("syncPublicPrendas2025 failed", error);
    return res.status(500).json({ok: false, error: String(error)});
  }
});

exports.importPrendasFromXlsxUpload = onRequest(RUNTIME_OPTS, async (req, res) => {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);
    const {buffer, filename, fileBytes} = await parseMultipartFile(req, "file");

    if (!buffer?.length) {
      return res.status(400).json({ok: false, error: "No file"});
    }

    console.info("importPrendasFromXlsxUpload file received", {
      filename,
      bytes: fileBytes,
    });

    const wb = XLSX.read(buffer, {type: "buffer"});
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      defval: "",
      raw: true,
      blankrows: false,
    });
    const headers = Array.isArray(rows[0]) ? rows[0] : [];
    const headerMap = new Map();
    headers.forEach((header, index) => {
      const key = normalizeHeaderKey(header);
      if (key && !headerMap.has(key)) headerMap.set(key, index);
    });

    const idxOrden = resolveColumnIndex(headerMap, HEADER_ALIASES.orden);
    const idxCodigo = resolveColumnIndex(headerMap, HEADER_ALIASES.codigo);
    const idxCosto = resolveColumnIndex(headerMap, HEADER_ALIASES.costo);
    const idxPrecioConIva = resolveColumnIndex(headerMap, HEADER_ALIASES.precioConIva);
    const idxPrecio = resolveColumnIndex(headerMap, HEADER_ALIASES.precio);
    const idxPVenta = resolveColumnIndex(headerMap, HEADER_ALIASES.pVenta);
    const idxDescripcion = resolveColumnIndex(headerMap, HEADER_ALIASES.descripcion);
    const idxTipo = resolveColumnIndex(headerMap, HEADER_ALIASES.tipo);
    const idxColor = resolveColumnIndex(headerMap, HEADER_ALIASES.color);
    const idxTalla = resolveColumnIndex(headerMap, HEADER_ALIASES.talla);
    const idxProveedor = resolveColumnIndex(headerMap, HEADER_ALIASES.proveedor);
    const idxStatus = resolveColumnIndex(headerMap, HEADER_ALIASES.status);
    const idxDisponibilidad = resolveColumnIndex(headerMap, HEADER_ALIASES.disponibilidad);
    const idxFecha = resolveColumnIndex(headerMap, HEADER_ALIASES.fecha);

    if (idxCodigo < 0) {
      return res.status(400).json({
        ok: false,
        error: "No se encontró columna de código (codigo/code/sku) en encabezados.",
      });
    }

    let batch = db.batch();
    let writesInBatch = 0;
    let updated = 0;
    const errors = [];

    for (let i = 1; i < rows.length; i++) {
      try {
        const row = rows[i];
        const codigoRaw = String(getRowValue(row, idxCodigo)).trim();
        const codigo = normalizeCodigo(codigoRaw);
        if (!codigo) continue;

        const docId = safeDocId(codigo);
        const ordenFromAlias = numOrUndefined(getRowValue(row, idxOrden));
        const ordenFromFirstCol = numOrUndefined(getRowValue(row, 0));
        const orden = Number.isFinite(ordenFromAlias) ? ordenFromAlias : ordenFromFirstCol;

        const costo = numOrUndefined(getRowValue(row, idxCosto));
        const idxPrecioConIvaFinal = idxPrecioConIva >= 0 ? idxPrecioConIva : (idxPrecio >= 0 ? idxPrecio : idxPVenta);
        const precioConIva = numOrUndefined(getRowValue(row, idxPrecioConIvaFinal));
        const utilidadCalc =
          Number.isFinite(precioConIva) && Number.isFinite(costo)
            ? toFixedNumber(precioConIva - costo, 2)
            : 0;
        const utilidad = Number.isFinite(utilidadCalc) ? utilidadCalc : 0;

        const margenCalc =
          Number.isFinite(utilidad) && Number.isFinite(costo) && costo > 0
            ? toFixedNumber((utilidad / costo) * 100, 1)
            : 0;
        const margen = Number.isFinite(margenCalc) ? margenCalc : 0;

const fechaRaw = getRowValue(row, idxFecha);

let fecha = null;
let fechaTexto = "";

if (typeof fechaRaw === "number" && Number.isFinite(fechaRaw) && fechaRaw > 0) {
  const parsed = XLSX.SSF.parse_date_code(fechaRaw);
  if (parsed) {
    fecha = new Date(Date.UTC(parsed.y, parsed.m - 1, parsed.d));
    fechaTexto = fecha.toISOString().slice(0, 10);
  }
} else if (fechaRaw instanceof Date && !isNaN(fechaRaw)) {
  fecha = fechaRaw;
  fechaTexto = fecha.toISOString().slice(0, 10);
} else if (typeof fechaRaw === "string" && fechaRaw.trim() !== "") {
  fechaTexto = fechaRaw.trim();
}

const status = String(getRowValue(row, idxStatus) ?? "").trim();
const disponibilidad =
  String(getRowValue(row, idxDisponibilidad) ?? "").trim() || status;


const masterObj = {
  orden: Number.isFinite(orden) ? orden : null,
  docId,
  code: codigo,
  codigo,
  costo: Number.isFinite(costo) ? costo : null,
  precioConIva: Number.isFinite(precioConIva) ? precioConIva : null,
  pVenta: Number.isFinite(precioConIva) ? precioConIva : null,
  utilidad,
  margen,
  descripcion: String(getRowValue(row, idxDescripcion) ?? "").trim(),
  tipo: String(getRowValue(row, idxTipo) ?? "").trim(),
  color: String(getRowValue(row, idxColor) ?? "").trim(),
  talla: String(getRowValue(row, idxTalla) ?? "").trim(),
  proveedor: String(getRowValue(row, idxProveedor) ?? "").trim(),
  status,
  disponibilidad,
  fechaTexto,
  fecha,
  source: "upload-xlsx",
  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
};

        const publicObj = buildPublicPayloadFromMaster(masterObj);
        const adminObj = buildAdminPayloadFromMaster(masterObj);
        publicObj.docId = docId;
        adminObj.docId = docId;

        batch.set(db.collection(PRENDAS_COLLECTION).doc(docId), masterObj, {merge: true});
        batch.set(db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId), publicObj, {merge: true});
        batch.set(db.collection(PRENDAS_ADMIN_COLLECTION).doc(docId), adminObj, {merge: true});
        writesInBatch += 3;
        updated += 1;

        if (writesInBatch >= 500) {
          await batch.commit();
          batch = db.batch();
          writesInBatch = 0;
        }
      } catch (error) {
        errors.push({row: i + 1, error: String(error)});
      }
    }

    if (writesInBatch > 0) {
      await batch.commit();
    }

    console.info("importPrendasFromXlsxUpload completed", {
      by: adminSession.email,
      filename,
      sheet: firstSheetName,
      updated,
      errors: errors.length
    });

    return res.status(200).json({ok: true, updated, errors});
  } catch (err) {
    if (err instanceof HttpsError) {
      return res.status(err.httpErrorCode.status).json({ok: false, error: err.message});
    }
    console.error("importPrendasFromXlsxUpload failed", err);
    return res.status(500).json({ok: false, error: String(err)});
  }
});

exports.importPrendasFromXlsx = exports.importPrendasFromXlsxUpload;


exports.recalcAdminFields = onRequest(RUNTIME_OPTS, async (req, res) => {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    await requireAllowlistedAdmin(req);

    const batchSize = 250;
    let updated = 0;
    let cursor = null;

    while (true) {
      let query = db
        .collection(PRENDAS_COLLECTION)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(batchSize);

      if (cursor) {
        query = query.startAfter(cursor);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      let batch = db.batch();
      let writes = 0;

      for (const docSnap of snapshot.docs) {
        const master = docSnap.data() || {};
        const docId = docSnap.id;

        const costo = numOrUndefined(master.costo);
        const precioConIva = numOrUndefined(master.precioConIva ?? master.pVenta);
        const utilidadActual = numOrUndefined(master.utilidad);
        const margenActual = numOrUndefined(master.margen);
        const orden = numOrUndefined(master.orden ?? master.seqNumber);

        let utilidad = utilidadActual;
        if ((!Number.isFinite(utilidad) || utilidad === 0) && Number.isFinite(costo) && Number.isFinite(precioConIva)) {
          utilidad = round2(precioConIva - costo);
        }

        let margen = margenActual;
        if ((!Number.isFinite(margen) || margen === 0) && Number.isFinite(costo) && costo > 0 && Number.isFinite(utilidad)) {
          margen = round1((utilidad / costo) * 100);
        }

        const adminPayload = {
          ...buildAdminPayloadFromMaster({...master, costo, precioConIva, utilidad, margen, orden}),
          utilidad: Number.isFinite(utilidad) ? utilidad : null,
          margen: Number.isFinite(margen) ? margen : null,
          orden: Number.isFinite(orden) ? orden : null,
        };
        const publicPayload = buildPublicPayloadFromMaster({...master, orden});

        batch.set(db.collection(PRENDAS_ADMIN_COLLECTION).doc(docId), adminPayload, {merge: true});
        batch.set(db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId), publicPayload, {merge: true});
        writes += 2;
        updated += 1;

        if (writes >= 500) {
          await batch.commit();
          batch = db.batch();
          writes = 0;
        }
      }

      if (writes > 0) {
        await batch.commit();
      }

      cursor = snapshot.docs[snapshot.docs.length - 1];
    }

    return res.status(200).json({ok: true, updated});
  } catch (err) {
    if (err instanceof HttpsError) {
      return res.status(err.httpErrorCode.status).json({ok: false, error: err.message});
    }
    console.error("recalcAdminFields failed", err);
    return res.status(500).json({ok: false, error: String(err)});
  }
});

exports.migrateSplitCollections = onRequest(RUNTIME_OPTS, async (req, res) => {
  try {
    if (applyCors(req, res)) return;
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);
    const batchSizeRaw = Number(req.body?.batchSize ?? req.query?.batchSize);
    const batchSize = Number.isFinite(batchSizeRaw)
      ? Math.max(MIGRATE_MIN_BATCH_SIZE, Math.min(MIGRATE_MAX_BATCH_SIZE, Math.floor(batchSizeRaw)))
      : DEFAULT_BATCH_SIZE;
    const startAfterCursor = String(req.body?.startAfter ?? req.query?.startAfter ?? "").trim();

    let baseQuery = db
      .collection(PRENDAS_COLLECTION)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(batchSize);

    if (startAfterCursor) {
      baseQuery = baseQuery.startAfter(startAfterCursor);
    }

    const snapshot = await baseQuery.get();
    if (snapshot.empty) {
      return res.status(200).json({
        ok: true,
        processed: 0,
        writtenPublic: 0,
        writtenAdmin: 0,
        lastDocCursor: null,
        hasMore: false,
        batchSize
      });
    }

    let read = 0;
    let skipped = 0;
    let writtenPublic = 0;
    let writtenAdmin = 0;
    const batch = db.batch();

    snapshot.docs.forEach((docSnap) => {
      const payload = docSnap.data() || {};
      read += 1;
      if (!payload || Object.keys(payload).length === 0) {
        skipped += 1;
        return;
      }
      const publicPayload = buildPublicPayloadFromMaster(payload);
      const adminPayload = buildAdminPayloadFromMaster(payload);
      const docId = safeDocId(publicPayload.docId ?? adminPayload.docId ?? payload.codigo ?? docSnap.id);
      publicPayload.docId = docId;
      adminPayload.docId = docId;

      batch.set(db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId), publicPayload, {merge: true});
      batch.set(db.collection(PRENDAS_ADMIN_COLLECTION).doc(docId), adminPayload, {merge: true});
      writtenPublic += 1;
      writtenAdmin += 1;
    });

    await batch.commit();
    const lastDocCursor = snapshot.docs[snapshot.docs.length - 1]?.id || null;
    const hasMore = snapshot.size === batchSize;

    console.info("migrateSplitCollections completed", {
      by: adminSession.email,
      batchSize,
      startAfter: startAfterCursor || null,
      read,
      publicWritten: writtenPublic,
      adminWritten: writtenAdmin,
      skipped,
      lastDocCursor,
      hasMore
    });

    return res.status(200).json({
      ok: true,
      read,
      processed: read,
      writtenPublic,
      writtenAdmin,
      skipped,
      lastDocCursor,
      hasMore,
      batchSize,
      startAfter: startAfterCursor || null
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      return res.status(error.httpErrorCode.status).json({ok: false, error: error.message});
    }
    console.error("migrateSplitCollections failed", error);
    return res.status(500).json({ok: false, error: String(error)});
  }
});

const safeString = (value) => {
  if (value === null || value === undefined) return "";
  return String(value);
};

const normalizeText = (value) =>
  safeString(value)
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeSku = (value) =>
  safeString(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

const tokenize = (value) => {
  const normalized = normalizeText(value).replace(/[^a-z0-9]+/g, " ");
  const tokens = normalized
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token && !STOPWORDS.has(token));
  return [...new Set(tokens)];
};

const requireAdminPassword = () => {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    throw new HttpsError(
      "failed-precondition",
      "Config admin.password no configurada."
    );
  }
  return password;
};

const verifyAdminSession = async (sessionId) => {
  if (!sessionId) {
    throw new HttpsError(
      "unauthenticated",
      "Sesión admin requerida."
    );
  }
  const session = adminSessions.get(sessionId);
  if (!session) {
    throw new HttpsError(
      "permission-denied",
      "Sesión admin inválida."
    );
  }
  const expiresAt = Number(session.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    adminSessions.delete(sessionId);
    throw new HttpsError(
      "permission-denied",
      "Sesión admin expirada."
    );
  }
  return session;
};

exports.verifyAdminPassword = onCall(RUNTIME_OPTS, async (request) => {
  let data = request.data || {};
  const password = safeString(data?.password).trim();
  if (!password) {
    throw new HttpsError(
      "invalid-argument",
      "Contraseña requerida."
    );
  }
  const adminPassword = requireAdminPassword();
  if (password !== adminPassword) {
    throw new HttpsError(
      "permission-denied",
      "Contraseña inválida."
    );
  }
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  const sessionId = randomUUID();
  adminSessions.set(sessionId, {expiresAt: expiresAtMs});
  console.info("Admin session creada", {sessionId});
  return {sessionId, expiresAt: expiresAtMs};
});

exports.backfillSearchTokens = onCall(RUNTIME_OPTS, async (request) => {
  let data = request.data || {};
  const sessionId = safeString(data?.sessionId).trim();
  await verifyAdminSession(sessionId);
  const cursor = safeString(data?.cursor).trim() || null;
  const batchSizeRaw = Number(data?.batchSize);
  const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
    ? Math.min(batchSizeRaw, 500)
    : DEFAULT_BATCH_SIZE;

  let baseQuery = admin
    .firestore()
    .collection(PRENDAS_COLLECTION)
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(batchSize);
  if (cursor) {
    baseQuery = baseQuery.startAfter(cursor);
  }

  const snapshot = await baseQuery.get();
  if (snapshot.empty) {
    return {
      processed: 0,
      updated: 0,
      skipped: 0,
      lastDocId: cursor,
      hasMore: false
    };
  }

  let updated = 0;
  let skipped = 0;
  const batch = admin.firestore().batch();

  snapshot.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    const codigo = safeString(
      data.codigo ||
        data.Codigo ||
        data.CODIGO ||
        data.code ||
        data.Code ||
        docSnap.id
    );
    const descripcion = safeString(
      data.descripcion || data.Descripcion || data.detalles || data.Detalles
    );
    const codigoLower = normalizeSku(codigo);
    const descripcionLower = normalizeText(descripcion);
    const searchTokens = tokenize(descripcionLower);
    const currentVersion = Number(data.searchVersion || 0);
    const hasTokens = Array.isArray(data.searchTokens) && data.searchTokens.length > 0;

    const needsUpdate =
      currentVersion < SEARCH_VERSION ||
      !hasTokens ||
      data.codigoLower !== codigoLower ||
      data.descripcionLower !== descripcionLower;

    if (needsUpdate) {
      batch.update(docSnap.ref, {
        codigoLower,
        descripcionLower,
        searchTokens,
        searchVersion: SEARCH_VERSION,
        searchUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      updated += 1;
    } else {
      skipped += 1;
    }
  });

  if (updated > 0) {
    await batch.commit();
  }

  const lastDoc = snapshot.docs[snapshot.docs.length - 1];
  const lastDocId = lastDoc?.id || cursor;
  return {
    processed: snapshot.size,
    updated,
    skipped,
    lastDocId,
    hasMore: snapshot.size === batchSize
  };
});

const resolvePVenta = (data = {}) => {
  const pVenta = Number(data.pVenta);
  if (Number.isFinite(pVenta)) {
    return Number(pVenta.toFixed(2));
  }

  const precioConIva = Number(data.precioConIva ?? data.precioConIVA);
  if (Number.isFinite(precioConIva)) {
    return Number(precioConIva.toFixed(2));
  }

  const precio = Number(data.precio ?? data.Precio ?? data.price);
  if (Number.isFinite(precio)) {
    return Number((precio * 1.16).toFixed(2));
  }

  return null;
};

exports.normalizePrendasPVenta = onCall(RUNTIME_OPTS, async (request) => {
  let data = request.data || {};
  const sessionId = safeString(data?.sessionId).trim();
  await verifyAdminSession(sessionId);

  const cursor = safeString(data?.cursor).trim() || null;
  const batchSizeRaw = Number(data?.batchSize);
  const batchSize = Number.isFinite(batchSizeRaw) && batchSizeRaw > 0
    ? Math.min(batchSizeRaw, 500)
    : DEFAULT_BATCH_SIZE;

  let baseQuery = admin
    .firestore()
    .collection(PRENDAS_COLLECTION)
    .orderBy(admin.firestore.FieldPath.documentId())
    .limit(batchSize);

  if (cursor) {
    baseQuery = baseQuery.startAfter(cursor);
  }

  const snapshot = await baseQuery.get();
  if (snapshot.empty) {
    return {
      processed: 0,
      updated: 0,
      skipped: 0,
      lastDocId: cursor,
      hasMore: false
    };
  }

  let updated = 0;
  let skipped = 0;
  const batch = admin.firestore().batch();

  snapshot.docs.forEach((docSnap) => {
    const payload = docSnap.data() || {};
    const normalizedPVenta = resolvePVenta(payload);

    if (!Number.isFinite(normalizedPVenta)) {
      skipped += 1;
      return;
    }

    if (Number(payload.pVenta) === normalizedPVenta) {
      skipped += 1;
      return;
    }

    batch.update(docSnap.ref, {
      pVenta: normalizedPVenta,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    updated += 1;
  });

  if (updated > 0) {
    await batch.commit();
  }

  const lastDoc = snapshot.docs[snapshot.docs.length - 1];
  const lastDocId = lastDoc?.id || cursor;

  return {
    processed: snapshot.size,
    updated,
    skipped,
    lastDocId,
    hasMore: snapshot.size === batchSize
  };
});


const APARTADOS_COLLECTION = "apartados";
const APARTADOS_COUNTER_DOC = "apartados_folio";
const TICKET_LOGO_PATH = "assets/haruja-logo.png";

const escHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

const fmtCurrency = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return "$0.00";
  return new Intl.NumberFormat("es-MX", {style: "currency", currency: "MXN"}).format(n);
};

const normalizeDiscountType = (value) => {
  const raw = String(value || "").trim().toUpperCase();
  return raw === "AMT" ? "AMT" : "PCT";
};

const calcDiscount = (subtotal, discountType, discountValue) => {
  const safeSubtotal = Math.max(0, Number(subtotal) || 0);
  const safeValue = Math.max(0, Number(discountValue) || 0);
  if (normalizeDiscountType(discountType) === "AMT") {
    return {
      type: "AMT",
      value: round2(safeValue) || 0,
      amount: round2(Math.min(safeSubtotal, safeValue)) || 0,
      label: `$${safeValue.toFixed(2)}`
    };
  }

  const pct = Math.min(100, safeValue);
  const amount = safeSubtotal * (pct / 100);
  return {
    type: "PCT",
    value: round2(pct) || 0,
    amount: round2(amount) || 0,
    label: `${round2(pct) || 0}%`
  };
};

const parseCodes = (input = "") => String(input)
  .split(",")
  .map((item) => normalizeCodigo(item))
  .filter(Boolean);

const buildFolio = (year, seq) => `HARUJA${String(year).slice(-2)}-${String(seq).padStart(3, "0")}`;

const encodeApartadosCursor = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");

const decodeApartadosCursor = (cursor) => {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    const createdAtMs = Number(parsed?.createdAtMs);
    if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) return null;
    return {
      createdAt: admin.firestore.Timestamp.fromMillis(createdAtMs),
      folio: String(parsed?.folio || "")
    };
  } catch (_err) {
    return null;
  }
};

const normalizeApartadoItem = (docSnap) => {
  const data = docSnap.data() || {};
  const createdAtTs = data.createdAt instanceof admin.firestore.Timestamp ? data.createdAt : null;
  const updatedAtTs = data.updatedAt instanceof admin.firestore.Timestamp ? data.updatedAt : null;
  return {
    folio: docSnap.id,
    fecha: String(data.fecha || ""),
    cliente: String(data.cliente || ""),
    contacto: String(data.contacto || ""),
    anticipo: Number(data.anticipo) || 0,
    total: Number(data.total) || 0,
    pdfUrl: String(data.pdfUrl || ""),
    createdAt: createdAtTs ? createdAtTs.toMillis() : null,
    updatedAt: updatedAtTs ? updatedAtTs.toMillis() : null
  };
};

const reserveNextFolio = async () => {
  const now = new Date();
  const year = now.getFullYear();
  const counterRef = db.collection("counters").doc(APARTADOS_COUNTER_DOC);

  const folio = await db.runTransaction(async (trx) => {
    const snap = await trx.get(counterRef);
    const data = snap.exists ? (snap.data() || {}) : {};
    const currentYear = Number(data.year) || year;
    const currentSeq = Number(data.value) || 0;
    const nextSeq = currentYear === year ? currentSeq + 1 : 1;
    trx.set(counterRef, {
      year,
      value: nextSeq,
      lastNumber: nextSeq,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, {merge: true});
    return buildFolio(year, nextSeq);
  });

  return folio;
};

const peekNextFolio = async () => {
  const now = new Date();
  const year = now.getFullYear();
  const snap = await db.collection("counters").doc(APARTADOS_COUNTER_DOC).get();
  const data = snap.exists ? (snap.data() || {}) : {};
  const currentYear = Number(data.year) || year;
  const currentSeq = Number(data.value) || 0;
  const nextSeq = currentYear === year ? currentSeq + 1 : 1;
  return buildFolio(year, nextSeq);
};

const buildTicketRows = async (codes = []) => {
  const cleanCodes = Array.from(new Set(codes.map((code) => normalizeCodigo(code)).filter(Boolean)));
  const rows = [];
  for (const code of cleanCodes) {
    const docId = safeDocId(code);
    const adminRef = db.collection(PRENDAS_ADMIN_COLLECTION).doc(docId);
    const masterRef = db.collection(PRENDAS_COLLECTION).doc(docId);
    const [adminSnap, masterSnap] = await Promise.all([adminRef.get(), masterRef.get()]);
    const data = adminSnap.exists ? (adminSnap.data() || {}) : (masterSnap.exists ? (masterSnap.data() || {}) : null);

    if (!data) {
      rows.push({
        codigo: code,
        descripcion: "Código no encontrado",
        precio: 0,
        cantidad: 1,
        subtotal: 0
      });
      continue;
    }

    const precio = resolvePVenta(data) || 0;
    rows.push({
      codigo: code,
      descripcion: data.descripcion || data.Descripción || "",
      precio,
      cantidad: 1,
      subtotal: precio
    });
  }
  return rows;
};

const buildStorageDownloadUrl = (bucketName, objectPath, token) => (
  `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`
);

const getOrCreateDownloadToken = async (file) => {
  const [metadata] = await file.getMetadata();
  const existing = String(metadata?.metadata?.firebaseStorageDownloadTokens || "")
    .split(",")
    .map((token) => token.trim())
    .find(Boolean);

  if (existing) return existing;

  const downloadToken = uuidv4();
  await file.setMetadata({
    metadata: {
      firebaseStorageDownloadTokens: downloadToken
    }
  });
  return downloadToken;
};

const buildLogoUrl = async () => {
  const bucket = admin.storage().bucket();
  const file = bucket.file(TICKET_LOGO_PATH);
  const [exists] = await file.exists();
  if (!exists) return "https://i.postimg.cc/nMphkZcC/haruja-logo.png";

  const downloadToken = await getOrCreateDownloadToken(file);
  return buildStorageDownloadUrl(bucket.name, TICKET_LOGO_PATH, downloadToken);
};

const renderTicketHtml = (ctx) => {
  const {
    folio, fecha, cliente, contacto, filas = [], subtotal = 0, anticipo = 0,
    descLabel = "0%", descVal = 0, total = 0, logoUrl = ""
  } = ctx;

  const fechaTxt = fecha ? String(fecha) : "";
  const verde = "#A7B59E";
  const marron = "#383234";
  const beige = "#FAF6F1";

  const rowsHtml = filas.map((f) => `
    <tr>
      <td>${escHtml(f.codigo)}</td>
      <td>${escHtml(f.descripcion)}</td>
      <td class="right">${fmtCurrency(f.precio)}</td>
      <td class="right">${Number(f.cantidad) || 1}</td>
      <td class="right">${fmtCurrency(f.subtotal)}</td>
    </tr>`).join("");

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Ticket ${escHtml(folio)}</title>
<style>*{box-sizing:border-box} body{font-family:Arial,sans-serif;color:${marron};margin:24px}
.head{position:relative;border-bottom:2px solid ${verde};padding:0 0 8px 0;margin:0 0 14px 0}
.title{font-size:18px;font-weight:bold}.badge{background:${verde};color:#fff;padding:4px 8px;border-radius:6px;font-weight:bold}
.logo{position:absolute;top:0;right:0;max-height:60px}
table{width:100%;border-collapse:collapse;margin-top:10px} th,td{border-bottom:1px solid #e7e7e7;padding:8px;font-size:12.5px;text-align:left;vertical-align:top}
th{background:${beige};font-weight:bold}.right{text-align:right}.totals{width:100%;margin-top:14px}.totals td{padding:6px 8px}.totals .lbl{text-align:right}.totals .val{text-align:right;width:120px}
.notes{margin-top:18px;font-size:11.5px;line-height:1.45}
</style></head><body>
<div class="head">
  <img src="${escHtml(logoUrl)}" class="logo">
  <div style="padding-right:120px">
    <div class="title">Pedido <span class="badge">${escHtml(folio)}</span></div>
    <div style="color:#555">Fecha ${escHtml(fechaTxt)}</div>
    <div style="color:#555;margin-top:6px">
      <div><b>Nombre del cliente</b>: ${escHtml(cliente)}</div>
      <div><b>N° de contacto</b>: ${escHtml(contacto)}</div>
    </div>
  </div>
</div>
<div class="title" style="font-size:16px">Detalles del pedido</div>
<table><thead><tr>
  <th style="width:18%">Código</th>
  <th style="width:52%">Descripción</th>
  <th class="right" style="width:10%">Precio</th>
  <th class="right" style="width:7%">Cant.</th>
  <th class="right" style="width:13%">Subtotal</th>
</tr></thead><tbody>${rowsHtml}</tbody></table>
<table class="totals">
  <tr><td class="lbl" colspan="4"><b>Subtotal</b></td><td class="val">${fmtCurrency(subtotal)}</td></tr>
  <tr><td class="lbl" colspan="4"><b>Anticipo</b></td><td class="val">${fmtCurrency(anticipo)}</td></tr>
  <tr><td class="lbl" colspan="4"><b>Descuento (${escHtml(descLabel)})</b></td><td class="val">-${fmtCurrency(descVal)}</td></tr>
  <tr><td class="lbl" colspan="4"><b>Total de Cuenta</b></td><td class="val"><b>${fmtCurrency(total)}</b></td></tr>
</table>
<div class="notes">Gracias por tu compra en HarujaGdl</div>
</body></html>`;
};

const generatePdfFromHtml = async (html) => {
  const executablePath = await chromium.executablePath();
  const browser = await puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath,
    headless: chromium.headless
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, {waitUntil: "networkidle0"});
    return await page.pdf({format: "A4", printBackground: true, margin: {top: "16px", right: "16px", bottom: "16px", left: "16px"}});
  } finally {
    await browser.close();
  }
};



const requireLoyaltyAdminHeader = (req) => {
  const expected = String(process.env.ADMIN_PASSWORD || "");
  const provided = String(req.get("X-Admin-Password") || "").trim();
  if (!expected || !provided || provided !== expected) {
    throw loyalty.buildBadRequestError("No autorizado", 403);
  }
};

const requireAllowedLoyaltyPublicOrigin = (req) => {
  const origin = String(req.get("origin") || "").trim();
  if (!LOYALTY_PUBLIC_UPDATE_ALLOWED_ORIGINS.has(origin)) {
    throw loyalty.buildBadRequestError("Origin not allowed", 403);
  }
};

const parseJsonBody = (req) => {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) {
    return JSON.parse(req.body);
  }
  return {};
};

const buildBadRequestError = (message, status = 400) => {
  const error = new Error(message);
  error.status = status;
  return error;
};

const validateApartadoPayload = (payload = {}, usarFolioExistente = false) => {
  const cliente = String(payload.cliente || "").trim();
  const contacto = String(payload.contacto || "").trim();
  const codigos = parseCodes(payload.codigos);
  const anticipo = Math.max(0, Number(payload.anticipo) || 0);
  const descuentoValor = Math.max(0, Number(payload.descuentoValor ?? payload.descuentoPct) || 0);
  const descuentoTipo = normalizeDiscountType(payload.descuentoTipo);
  const folio = String(payload.folio || "").trim().toUpperCase();

  if (!cliente) throw buildBadRequestError("El nombre del cliente es obligatorio.");
  if (!contacto) throw buildBadRequestError("El contacto es obligatorio.");

  if (usarFolioExistente) {
    if (!folio) throw buildBadRequestError("Ingresa el folio para aplicar el abono.");
    if (anticipo <= 0) throw buildBadRequestError("El anticipo debe ser mayor a 0 para abonos.");
  } else {
    if (!codigos.length) throw buildBadRequestError("Debes ingresar al menos un código de prenda.");
    if (descuentoTipo === "PCT" && descuentoValor > 100) {
      throw buildBadRequestError("El descuento en porcentaje no puede ser mayor a 100.");
    }
  }

  return {cliente, contacto, codigos, anticipo, descuentoValor, descuentoTipo, folio};
};

exports.api = onRequest(RUNTIME_OPTS, async (req, res) => {
  if (applyCors(req, res)) return;
  const path = String(req.path || req.url || "").split("?")[0];

  try {
    if (path === "/api/apartados/next-folio" && req.method === "GET") {
      const folio = await peekNextFolio();
      res.status(200).json({ok: true, folio});
      return;
    }

    if (path === "/api/apartados/list" && req.method === "GET") {
      const requestedLimit = Number(req.query?.limit);
      const limit = Math.max(1, Math.min(100, Number.isFinite(requestedLimit) ? requestedLimit : 50));
      const cursor = decodeApartadosCursor(req.query?.cursor);
      const q = String(req.query?.q || "").trim().toUpperCase();

      let items = [];
      let nextCursor = null;

      if (q.startsWith("HARUJA")) {
        const exactRef = db.collection(APARTADOS_COLLECTION).doc(q);
        const exactSnap = await exactRef.get();
        if (exactSnap.exists) {
          items = [normalizeApartadoItem(exactSnap)];
        } else {
          const prefixQuery = db.collection(APARTADOS_COLLECTION)
            .orderBy(admin.firestore.FieldPath.documentId())
            .startAt(q)
            .endAt(`${q}\uf8ff`)
            .limit(limit);
          const prefixSnap = await prefixQuery.get();
          items = prefixSnap.docs.map(normalizeApartadoItem);
        }
      } else {
        let query = db.collection(APARTADOS_COLLECTION)
          .orderBy("createdAt", "desc")
          .limit(limit);

        if (cursor?.createdAt) {
          query = query.startAfter(cursor.createdAt);
        }

        const snap = await query.get();
        items = snap.docs.map(normalizeApartadoItem);

        if (snap.size === limit) {
          const lastDoc = snap.docs[snap.docs.length - 1];
          const lastCreatedAt = lastDoc.get("createdAt");
          if (lastCreatedAt instanceof admin.firestore.Timestamp) {
            nextCursor = encodeApartadosCursor({
              createdAtMs: lastCreatedAt.toMillis(),
              folio: lastDoc.id
            });
          }
        }
      }

      res.status(200).json({ok: true, items, nextCursor});
      return;
    }

    if (path === "/api/apartados/get" && req.method === "GET") {
      const folio = String(req.query?.folio || "").trim().toUpperCase();
      if (!folio) {
        res.status(400).json({ok: false, error: "Falta query param folio."});
        return;
      }

      const snap = await db.collection(APARTADOS_COLLECTION).doc(folio).get();
      if (!snap.exists) {
        res.status(404).json({ok: false, error: `No encontré el folio "${folio}".`});
        return;
      }

      const data = snap.data() || {};
      const createdAtTs = data.createdAt instanceof admin.firestore.Timestamp ? data.createdAt : null;
      const updatedAtTs = data.updatedAt instanceof admin.firestore.Timestamp ? data.updatedAt : null;
      res.status(200).json({
        ok: true,
        item: {
          folio: snap.id,
          ...data,
          createdAt: createdAtTs ? createdAtTs.toMillis() : null,
          updatedAt: updatedAtTs ? updatedAtTs.toMillis() : null
        }
      });
      return;
    }

    if (path === "/api/apartados/registrar" && req.method === "POST") {
      const payload = parseJsonBody(req);
      const usarFolioExistente = !!payload.usarFolioExistente;
      const generarTicket = payload.generarTicket !== false;
      const validated = validateApartadoPayload(payload, usarFolioExistente);
      const anticipoInput = validated.anticipo;

      let folio = validated.folio;
      let docRef;
      let apartadoData;

      if (usarFolioExistente) {
        docRef = db.collection(APARTADOS_COLLECTION).doc(folio);
        const snap = await docRef.get();
        if (!snap.exists) {
          res.status(404).json({ok: false, error: `No encontré el folio "${folio}".`});
          return;
        }
        apartadoData = snap.data() || {};
      } else {
        folio = await reserveNextFolio();
        docRef = db.collection(APARTADOS_COLLECTION).doc(folio);
        const rows = await buildTicketRows(validated.codigos);
        const subtotal = round2(rows.reduce((acc, row) => acc + (Number(row.subtotal) || 0), 0)) || 0;
        const discount = calcDiscount(subtotal, payload.descuentoTipo, payload.descuentoValor ?? payload.descuentoPct);
        const total = round2(Math.max(0, subtotal - discount.amount - anticipoInput)) || 0;

        apartadoData = {
          folio,
          fecha: String(payload.fecha || ""),
          cliente: validated.cliente,
          contacto: validated.contacto,
          codigos: rows.map((row) => row.codigo),
          filas: rows,
          subtotal,
          anticipo: anticipoInput,
          descTipo: discount.type,
          descValor: discount.value,
          descVal: discount.amount,
          total,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        await docRef.set(apartadoData, {merge: true});
      }

      if (usarFolioExistente) {
        const subtotal = Number(apartadoData.subtotal) || 0;
        const anticipo = round2((Number(apartadoData.anticipo) || 0) + anticipoInput) || 0;
        const discount = calcDiscount(subtotal, apartadoData.descTipo, apartadoData.descValor);
        const total = round2(Math.max(0, subtotal - discount.amount - anticipo)) || 0;
        apartadoData = {
          ...apartadoData,
          anticipo,
          descVal: discount.amount,
          total,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };
        await docRef.set(apartadoData, {merge: true});
      }

      let pdfUrl = "";
      if (generarTicket) {
        const logoUrl = await buildLogoUrl();
        const html = renderTicketHtml({
          folio,
          fecha: apartadoData.fecha,
          cliente: apartadoData.cliente,
          contacto: apartadoData.contacto,
          filas: apartadoData.filas || [],
          subtotal: apartadoData.subtotal,
          anticipo: apartadoData.anticipo,
          descLabel: calcDiscount(apartadoData.subtotal, apartadoData.descTipo, apartadoData.descValor).label,
          descVal: apartadoData.descVal,
          total: apartadoData.total,
          logoUrl
        });
        const pdfBuffer = await generatePdfFromHtml(html);
        const bucket = admin.storage().bucket();
        const ticketPath = `tickets/apartados/${folio}.pdf`;
        const file = bucket.file(ticketPath);
        const downloadToken = uuidv4();
        await file.save(pdfBuffer, {
          contentType: "application/pdf",
          resumable: false,
          metadata: {
            metadata: {
              firebaseStorageDownloadTokens: downloadToken
            }
          }
        });
        pdfUrl = buildStorageDownloadUrl(bucket.name, ticketPath, downloadToken);
        console.log("pdfUrl generado por token", {folio, ticketPath, pdfUrl});
        await docRef.set({pdfPath: ticketPath, pdfUrl, updatedAt: admin.firestore.FieldValue.serverTimestamp()}, {merge: true});
      }

      res.status(200).json({
        ok: true,
        folio,
        resumen: {
          subtotal: apartadoData.subtotal || 0,
          anticipo: apartadoData.anticipo || 0,
          descVal: apartadoData.descVal || 0,
          total: apartadoData.total || 0
        },
        pdfUrl
      });
      return;
    }

    if (path === "/api/loyalty/registerClient" && req.method === "POST") {
      const response = await loyalty.registerClient({body: parseJsonBody(req), get: (name) => req.get(name)}, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/searchClients" && req.method === "GET") {
      const response = await loyalty.searchClients(req, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/addPurchase" && req.method === "POST") {
      const response = await loyalty.addPurchase({body: parseJsonBody(req)}, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/redeem" && req.method === "POST") {
      const response = await loyalty.redeem({body: parseJsonBody(req)}, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/getByToken" && req.method === "GET") {
      const response = await loyalty.getByToken(req, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/addVisit" && req.method === "POST") {
      const response = await loyalty.addVisit({body: parseJsonBody(req)}, db);
      res.status(200).json(response);
      return;
    }


    if (path === "/api/loyalty/updateClient" && req.method === "PATCH") {
      requireLoyaltyAdminHeader(req);
      const response = await loyalty.updateClient({body: parseJsonBody(req)}, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/updateClientPublic" && req.method === "PATCH") {
      requireAllowedLoyaltyPublicOrigin(req);
      const response = await loyalty.updateClient({body: parseJsonBody(req)}, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/listClients" && req.method === "GET") {
      const response = await loyalty.listClients(req, db);
      res.status(200).json(response);
      return;
    }

    if (path === "/api/loyalty/backfillQrLinks" && req.method === "POST") {
      const key = String(req.query?.key || "");
      const expected = String(process.env.BACKFILL_KEY || "");
      if (!expected || key !== expected) {
        throw new Error("No autorizado");
      }
      const response = await loyalty.backfillQrLinks(req, db);
      res.status(200).json(response);
      return;
    }

    if ((path === "/api/dashboard/sales-summary" || path === "/dashboard/sales-summary") && req.method === "GET") {
      const storeId = String(req.query?.storeId || "").trim();
      const month = String(req.query?.month || "").trim();
      const summary = await buildSalesDataset({storeId, month});
      res.status(200).json({
        ok: true,
        month: summary.month,
        storeId: summary.storeId,
        totalMes: summary.totalMes,
        totalSinAsignar: summary.totalSinAsignar,
        totalPorVendedora: summary.totalPorVendedora
      });
      return;
    }

    if ((path === "/api/dashboard/sales-details" || path === "/dashboard/sales-details") && req.method === "GET") {
      const storeId = String(req.query?.storeId || "").trim();
      const month = String(req.query?.month || "").trim();
      const summary = await buildSalesDataset({storeId, month});
      res.status(200).json({
        ok: true,
        month: summary.month,
        storeId: summary.storeId,
        orders: summary.orders,
        totalMes: summary.totalMes,
        totalSinAsignar: summary.totalSinAsignar,
        totalPorVendedora: summary.totalPorVendedora
      });
      return;
    }

    if ((path === "/api/dashboard/sales-export.csv" || path === "/dashboard/sales-export.csv") && req.method === "GET") {
      const storeId = String(req.query?.storeId || "").trim();
      const month = String(req.query?.month || "").trim();
      const summary = await buildSalesDataset({storeId, month});
      const orderCounts = {};
      for (const order of summary.orders) {
        const sellerKey = String(order.seller || "").trim() || "Sin asignar";
        orderCounts[sellerKey] = (orderCounts[sellerKey] || 0) + 1;
      }

      const rows = [];
      rows.push(["seller", "total vendido", "numero pedidos", "ticket promedio"]);

      const sellers = new Set(summary.totalPorVendedora.map((item) => item.seller));
      if (summary.totalSinAsignar > 0) sellers.add("Sin asignar");

      for (const seller of sellers) {
        const total = seller === "Sin asignar"
          ? summary.totalSinAsignar
          : (summary.totalPorVendedora.find((item) => item.seller === seller)?.total || 0);
        const count = orderCounts[seller] || 0;
        const avg = count > 0 ? Number((total / count).toFixed(2)) : 0;
        rows.push([seller, total.toFixed(2), String(count), avg.toFixed(2)]);
      }

      const csvContent = rows.map((row) => row.map(toCsvEscaped).join(",")).join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename=ventas-comisiones-${summary.month}.csv`);
      res.status(200).send(csvContent);
      return;
    }

    if ((path === "/api/dashboard/order-seller" || path === "/dashboard/order-seller") && req.method === "PATCH") {
      const payload = parseJsonBody(req);
      const orderId = String(payload?.orderId || "").trim();
      const seller = String(payload?.seller || "").trim();
      if (!orderId) {
        res.status(400).json({ok: false, error: "orderId es obligatorio."});
        return;
      }

      await db.collection(ORDER_SELLER_COLLECTION).doc(orderId).set({
        seller,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, {merge: true});

      res.status(200).json({ok: true, orderId, seller});
      return;
    }

    res.status(404).json({ok: false, error: "Ruta no encontrada."});
  } catch (error) {
    console.error("API apartados error", error);
    const message = error instanceof HttpsError ? error.message : (error?.message || "Error interno");
    if (error instanceof SyntaxError) {
      res.status(400).json({ok: false, error: "JSON inválido en el body."});
      return;
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
      res.status(error.status).json({ok: false, error: message});
      return;
    }
    const status = error instanceof HttpsError && error.code === "permission-denied" ? 403 : 500;
    res.status(status).json({ok: false, error: message});
  }
});


const pickPublicFieldsFromAdmin = (data = {}) => ({
  docId: data.docId ?? null,
  codigo: data.codigo ?? null,
  code: data.code ?? data.codigo ?? null,
  baseCode: data.baseCode ?? null,
  variantKey: data.variantKey ?? null,
  descripcion: data.descripcion ?? null,
  tipo: data.tipo ?? null,
  color: data.color ?? null,
  talla: data.talla ?? null,
  proveedor: data.proveedor ?? null,
  status: data.status ?? null,
  disponibilidad: data.disponibilidad ?? null,
  fecha: data.fecha ?? null,
  fechaTexto: data.fechaTexto ?? null,
  fechaAlta: data.fechaAlta ?? null,
  fechaAltaTexto: data.fechaAltaTexto ?? null,
  orden: resolveOrden(data),
  pVenta: toNumberOrNull(data.pVenta ?? data.precioConIva),
  precioConIva: toNumberOrNull(data.precioConIva ?? data.pVenta),
  pVentaVisible: toNumberOrNull(data.pVenta ?? data.precioConIva)
});

exports.replicateAdminToPublic = onDocumentWritten(
  `${PRENDAS_ADMIN_COLLECTION}/{docId}`,
  async (event) => {
    const docId = safeDocId(event.params.docId);
    const beforeExists = event.data?.before?.exists;
    const afterExists = event.data?.after?.exists;

    if (!afterExists) {
      if (beforeExists) {
        await db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId).delete().catch(() => {});
      }
      return;
    }

    const adminData = event.data.after.data() || {};
    const payload = pickPublicFieldsFromAdmin(adminData);
    payload.docId = docId;
    if (!payload.codigo) {
      payload.codigo = normalizeCodigo(adminData.codigo || docId.replaceAll("__", "/"));
    }
    if (!payload.code) payload.code = payload.codigo;
    payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    Object.keys(payload).forEach((key) => {
      if (payload[key] === undefined) delete payload[key];
    });

    await db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docId).set(payload, {merge: true});
  }
);
