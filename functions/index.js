const functions = require("firebase-functions");
const {setGlobalOptions} = require("firebase-functions");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({maxInstances: 10});

const PRENDAS_COLLECTION = "HarujaPrendas_2025";
const ADMIN_SESSIONS_COLLECTION = "admin_sessions";
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
  const config = functions.config();
  const password = config?.admin?.password;
  if (!password) {
    throw new functions.https.HttpsError(
      "failed-precondition",
      "Config admin.password no configurada."
    );
  }
  return password;
};

const verifyAdminSession = async (sessionId) => {
  if (!sessionId) {
    throw new functions.https.HttpsError(
      "unauthenticated",
      "Sesión admin requerida."
    );
  }
  const sessionRef = admin.firestore().collection(ADMIN_SESSIONS_COLLECTION).doc(sessionId);
  const sessionSnap = await sessionRef.get();
  if (!sessionSnap.exists) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Sesión admin inválida."
    );
  }
  const data = sessionSnap.data() || {};
  const expiresAt =
    typeof data.expiresAt?.toMillis === "function"
      ? data.expiresAt.toMillis()
      : Number(data.expiresAt);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Sesión admin expirada."
    );
  }
  return sessionRef;
};

exports.verifyAdminPassword = functions.https.onCall(async (data) => {
  const password = safeString(data?.password).trim();
  if (!password) {
    throw new functions.https.HttpsError(
      "invalid-argument",
      "Contraseña requerida."
    );
  }
  const adminPassword = requireAdminPassword();
  if (password !== adminPassword) {
    throw new functions.https.HttpsError(
      "permission-denied",
      "Contraseña inválida."
    );
  }
  const sessionRef = admin.firestore().collection(ADMIN_SESSIONS_COLLECTION).doc();
  const expiresAtMs = Date.now() + SESSION_TTL_MS;
  await sessionRef.set({
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromMillis(expiresAtMs)
  });
  logger.info("Admin session creada", {sessionId: sessionRef.id});
  return {sessionId: sessionRef.id, expiresAt: expiresAtMs};
});

exports.backfillSearchTokens = functions.https.onCall(async (data) => {
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
