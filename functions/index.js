const {onRequest, onCall, HttpsError} = require("firebase-functions/v2/https");
const {setGlobalOptions} = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const {randomUUID} = require("crypto");
const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");

admin.initializeApp();
setGlobalOptions({maxInstances: 10});
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
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
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

const safeDocId = (val) => String(val ?? "").trim().replaceAll("/", "_");

const getCell = (sheet, col, row) => {
  const cell = sheet[`${col}${row}`];
  return cell ? cell.v : "";
};

const toNumber = (v) => {
  if (!v) return null;
  const n = Number(String(v).replace(/[,$\s]/g, ""));
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
  const orden = Number(data.orden);
  if (Number.isFinite(orden)) return orden;
  const seqNumber = Number(data.seqNumber);
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

const buildPublicPayloadFromMaster = (data = {}) => ({
  orden: resolveOrden(data),
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
  pVenta: resolvePVentaFromMaster(data),
  precio: toFixedNumber(data.precio)
});

const buildAdminPayloadFromMaster = (data = {}) => ({
  ...buildPublicPayloadFromMaster(data),
  costo: toFixedNumber(data.costo),
  margen: toFixedNumber(data.margen, 3),
  iva: toFixedNumber(data.iva, 4),
  precioConIva: toFixedNumber(data.precioConIva ?? data.precioConIVA),
  providerCode: data.providerCode ?? null,
  typeCode: data.typeCode ?? null
});

exports.splitPrendasToPublicAdmin = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);
    const dryRunRaw = req.query?.dryRun ?? req.body?.dryRun;
    const dryRun = [true, "true", "1", 1].includes(dryRunRaw);
    const limitRaw = Number(req.body?.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
    const startAfter = String(req.body?.startAfter || "").trim();
    const chunkSize = 400;

    let processed = 0;
    let writtenPublic = 0;
    let writtenAdmin = 0;
    let lastDocId = startAfter || null;
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      let baseQuery = db
        .collection(PRENDAS_COLLECTION)
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
        const publicData = buildPublicPayloadFromMaster(payload);
        const adminData = buildAdminPayloadFromMaster(payload);
        processed += 1;
        lastDocId = docSnap.id;

        if (!dryRun) {
          batch.set(db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docSnap.id), publicData, {merge: true});
          batch.set(db.collection(PRENDAS_ADMIN_COLLECTION).doc(docSnap.id), adminData, {merge: true});
          writtenPublic += 1;
          writtenAdmin += 1;
        }
      }

      if (!dryRun) {
        await batch.commit();
      }

      logger.info("splitPrendasToPublicAdmin chunk", {
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

    return res.status(200).json({
      ok: true,
      processed,
      writtenPublic,
      writtenAdmin,
      lastDocId
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      return res.status(error.httpErrorCode.status).json({ok: false, error: error.message});
    }
    logger.error("splitPrendasToPublicAdmin failed", error);
    return res.status(500).json({ok: false, error: String(error)});
  }
});

exports.syncPublicPrendas2025 = onRequest(async (req, res) => {
  try {
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
    logger.error("syncPublicPrendas2025 failed", error);
    return res.status(500).json({ok: false, error: String(error)});
  }
});

exports.importPrendasFromXlsx = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);

    const candidatePaths = [
      path.join(__dirname, "data", "HarujaPrendas_2025.xlsx"),
      path.join(__dirname, "..", "Data", "HarujaPrendas_2025.xlsx")
    ];
    const probeResults = candidatePaths.map((candidate) => {
      const exists = fs.existsSync(candidate);
      const bytes = exists ? fs.statSync(candidate).size : 0;
      return {
        path: candidate,
        exists,
        bytes
      };
    });
    const foundCandidate = probeResults.find((candidate) => candidate.exists);
    const filePath = foundCandidate?.path || "";

    logger.info("XLSX probe results", {
      by: adminSession.email,
      candidates: probeResults
    });

    if (!filePath) {
      throw new Error(
        "XLSX no encontrado en runtime. Revisa deploy de Functions y que el archivo exista en functions/data o Data/."
      );
    }

    logger.info("START importPrendasFromXlsx", {
      by: adminSession.email,
      filePath,
      xlsxFound: true,
      bytes: foundCandidate.bytes
    });

    const wb = XLSX.readFile(filePath);
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    const range = XLSX.utils.decode_range(sheet["!ref"]);
    const rowsTotal = Math.max(0, range.e.r);
    logger.info("rows total", {rowsTotal, sheet: firstSheetName});

    let batch = db.batch();
    let writesInBatch = 0;
    let rowsImported = 0;
    let writtenMaster = 0;

    for (let r = 2; r <= range.e.r + 1; r++) {
      const codigo = String(getCell(sheet, "B", r)).trim();
      if (!codigo) continue;

      const docId = safeDocId(codigo);

      const masterObj = {
        orden: toNumber(getCell(sheet, "A", r)),
        seqNumber: toNumber(getCell(sheet, "A", r)),
        codigo,
        descripcion: String(getCell(sheet, "F", r)),
        tipo: String(getCell(sheet, "C", r)),
        color: String(getCell(sheet, "D", r)),
        talla: String(getCell(sheet, "E", r)),
        proveedor: String(getCell(sheet, "M", r)),
        status: String(getCell(sheet, "L", r)),
        disponibilidad: String(getCell(sheet, "L", r)),
        fechaTexto: String(getCell(sheet, "J", r)),
        fecha: getCell(sheet, "J", r) || null,
        precio: toNumber(getCell(sheet, "G", r)),
        precioConIva: toNumber(getCell(sheet, "I", r)),
        pVenta: toNumber(getCell(sheet, "I", r)),
        iva: 0.16,
        costo: toNumber(getCell(sheet, "N", r)),
        margen: toNumber(getCell(sheet, "Q", r)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };

      batch.set(db.collection(PRENDAS_COLLECTION).doc(docId), masterObj, {merge: true});

      writesInBatch += 1;
      rowsImported += 1;
      writtenMaster += 1;

      if (writesInBatch >= 500) {
        logger.info("writing batch", {writesInBatch, rowsImported});
        await batch.commit();
        batch = db.batch();
        writesInBatch = 0;
      }
    }

    if (writesInBatch > 0) {
      logger.info("writing batch", {writesInBatch, rowsImported});
      await batch.commit();
    }

    logger.info("DONE importPrendasFromXlsx", {
      rowsImported,
      writtenMaster
    });

    res.json({
      ok: true,
      sheet: firstSheetName,
      rowsTotal,
      rowsImported,
      writtenMaster,
      publicCollection: PRENDAS_PUBLIC_COLLECTION,
      adminCollection: PRENDAS_ADMIN_COLLECTION
    });
  } catch (err) {
    if (err instanceof HttpsError) {
      return res.status(err.httpErrorCode.status).json({
        ok: false,
        error: err.message
      });
    }
    logger.error("importPrendasFromXlsx failed", err);
    res.status(500).json({ok: false, error: String(err)});
  }
});

exports.migrateSplitCollections = onRequest(async (req, res) => {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ok: false, error: "Method not allowed. Use POST."});
    }

    const adminSession = await requireAllowlistedAdmin(req);
    let totalRead = 0;
    let publicWrites = 0;
    let adminWrites = 0;
    let firstDocId = null;
    let lastDocId = null;
    let cursor = null;
    let hasMore = true;

    while (hasMore) {
      let baseQuery = db
        .collection(PRENDAS_COLLECTION)
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(DEFAULT_BATCH_SIZE);
      if (cursor) {
        baseQuery = baseQuery.startAfter(cursor);
      }

      const snapshot = await baseQuery.get();
      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();
      snapshot.docs.forEach((docSnap, index) => {
        const payload = docSnap.data() || {};
        if (!firstDocId && index === 0) {
          firstDocId = docSnap.id;
        }
        lastDocId = docSnap.id;
        totalRead += 1;

        batch.set(
          db.collection(PRENDAS_PUBLIC_COLLECTION).doc(docSnap.id),
          buildPublicPayloadFromMaster(payload),
          {merge: true}
        );
        batch.set(
          db.collection(PRENDAS_ADMIN_COLLECTION).doc(docSnap.id),
          buildAdminPayloadFromMaster(payload),
          {merge: true}
        );
        publicWrites += 1;
        adminWrites += 1;
      });

      await batch.commit();
      cursor = snapshot.docs[snapshot.docs.length - 1];
      hasMore = snapshot.size === DEFAULT_BATCH_SIZE;
    }

    logger.info("migrateSplitCollections completed", {
      by: adminSession.email,
      totalRead,
      publicWrites,
      adminWrites,
      firstDocId,
      lastDocId
    });

    return res.status(200).json({
      ok: true,
      totalRead,
      publicWrites,
      adminWrites,
      firstDocId,
      lastDocId
    });
  } catch (error) {
    if (error instanceof HttpsError) {
      return res.status(error.httpErrorCode.status).json({ok: false, error: error.message});
    }
    logger.error("migrateSplitCollections failed", error);
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

exports.verifyAdminPassword = onCall(async (request) => {
  const data = request.data || {};
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
  logger.info("Admin session creada", {sessionId});
  return {sessionId, expiresAt: expiresAtMs};
});

exports.backfillSearchTokens = onCall(async (request) => {
  const data = request.data || {};
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

exports.normalizePrendasPVenta = onCall(async (request) => {
  const data = request.data || {};
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
