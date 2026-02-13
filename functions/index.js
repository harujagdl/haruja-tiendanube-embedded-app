const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const admin = require("firebase-admin");
const {randomUUID} = require("crypto");
const Busboy = require("busboy");
const XLSX = require("xlsx");

admin.initializeApp();
const db = admin.firestore();

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
  "http://localhost:5000",
  "http://localhost:5173",
  "http://localhost:3000"
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
    const contentType = String(req.headers["content-type"] || "");
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      reject(new Error("Content-Type debe ser multipart/form-data."));
      return;
    }

    const busboy = Busboy({headers: req.headers});
    const chunks = [];
    let matchedFile = false;
    let filename = "";
    let mimeType = "";

    busboy.on("file", (name, stream, info) => {
      if (name !== fieldName) {
        stream.resume();
        return;
      }

      matchedFile = true;
      filename = String(info?.filename || "");
      mimeType = String(info?.mimeType || "");

      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("error", (error) => reject(error));
    });

    busboy.on("error", reject);
    busboy.on("finish", () => {
      if (!matchedFile) {
        reject(new Error("Campo file requerido."));
        return;
      }
      resolve({
        buffer: Buffer.concat(chunks),
        filename,
        mimeType,
      });
    });

    req.pipe(busboy);
  });

function applyCors(req, res) {
  const origin = req.get("origin");
  const allowOrigin = ALLOWED_ORIGINS.has(origin) ? origin : "https://haruja-tiendanube.web.app";
  res.set("Access-Control-Allow-Origin", allowOrigin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
  const utilidadRaw = numOrUndefined(masterData.utilidad);
  const margenRaw = numOrUndefined(masterData.margen);

  const utilidadCalc =
    Number.isFinite(precioConIva) && Number.isFinite(costo)
      ? Number(precioConIva - costo)
      : undefined;

  const margenCalc =
    Number.isFinite(utilidadCalc) && Number.isFinite(costo) && costo > 0
      ? Number((utilidadCalc / costo) * 100)
      : undefined;

  const utilidad = Number.isFinite(utilidadRaw) ? utilidadRaw : utilidadCalc;
  const margen = Number.isFinite(margenRaw) ? margenRaw : margenCalc;

  return {
    ...buildPublicPayloadFromMaster(masterData),
    ...(costo !== undefined ? {costo} : {}),
    ...(precioConIva !== undefined ? {precioConIva} : {}),
    ...(precioConIva !== undefined ? {pVenta: precioConIva} : {}),
    ...(utilidad !== undefined ? {utilidad} : {}),
    ...(margen !== undefined ? {margen} : {}),
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
    const {buffer, filename} = await parseMultipartFile(req, "file");

    if (!buffer?.length) {
      return res.status(400).json({ok: false, error: "Archivo XLSX vacío."});
    }

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
    const idxMargen = resolveColumnIndex(headerMap, HEADER_ALIASES.margen);
    const idxUtilidad = resolveColumnIndex(headerMap, HEADER_ALIASES.utilidad);
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
        const precioConIva = numOrUndefined(getRowValue(row, idxPrecioConIva));
        const utilidadOverride = toFixedNumber(numOrUndefined(getRowValue(row, idxUtilidad)), 2);
        const margenOverride = toFixedNumber(numOrUndefined(getRowValue(row, idxMargen)), 2);

        const utilidadCalc =
          Number.isFinite(precioConIva) && Number.isFinite(costo)
            ? toFixedNumber(precioConIva - costo, 2)
            : null;
        const utilidad = Number.isFinite(utilidadOverride) ? utilidadOverride : utilidadCalc;

        const margenCalc =
          Number.isFinite(utilidad) && Number.isFinite(costo) && costo > 0
            ? toFixedNumber((utilidad / costo) * 100, 2)
            : null;
        const margen = Number.isFinite(margenOverride) ? margenOverride : margenCalc;

        const fechaValue = getRowValue(row, idxFecha);
        const fechaTexto = String(fechaValue ?? "").trim();
        const status = String(getRowValue(row, idxStatus) ?? "").trim();
        const disponibilidad = String(getRowValue(row, idxDisponibilidad) ?? "").trim() || status;

        const masterObj = {
          ...(Number.isFinite(orden) ? {orden} : {}),
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
          fecha: fechaValue || null,
          source: "upload-xlsx",
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
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
