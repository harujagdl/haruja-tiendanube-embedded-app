import process from "process";
import admin from "firebase-admin";

const COLLECTION_NAME = "HarujaPrendas_2025";
const BATCH_LIMIT = 400;

const parseBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const formatDateText = (date) => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
};

const toDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (typeof value?.toDate === "function") return value.toDate();
  if (typeof value === "number") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return null;

    const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
    if (match) {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = Number(match[3]);
      const date = new Date(year, month - 1, day);
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
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

const main = async () => {
  const dryRun = parseBoolean(process.env.DRY_RUN ?? "true", true);
  const db = initFirestore();
  const snap = await db.collection(COLLECTION_NAME).get();

  let scanned = 0;
  let candidates = 0;
  const updates = [];

  snap.forEach((docSnap) => {
    scanned += 1;
    const data = docSnap.data() || {};

    const hasFechaAlta = data.fechaAlta !== undefined && data.fechaAlta !== null;
    if (hasFechaAlta) return;

    const payload = {};
    const legacyFechaTexto = String(data.fechaTexto ?? data.FechaTexto ?? "").trim();
    const legacyFecha = data.fecha ?? data.Fecha ?? null;

    if (legacyFechaTexto) {
      payload.fechaAltaTexto = legacyFechaTexto;
    }

    const parsedLegacyFecha = toDateValue(legacyFecha);
    if (parsedLegacyFecha) {
      const cleanDate = new Date(
        parsedLegacyFecha.getFullYear(),
        parsedLegacyFecha.getMonth(),
        parsedLegacyFecha.getDate()
      );
      payload.fechaAlta = admin.firestore.Timestamp.fromDate(cleanDate);
      if (!payload.fechaAltaTexto) {
        payload.fechaAltaTexto = formatDateText(cleanDate);
      }
    }

    if (Object.keys(payload).length > 0) {
      candidates += 1;
      updates.push({ id: docSnap.id, payload });
    }
  });

  console.log(`Colección: ${COLLECTION_NAME}`);
  console.log(`Documentos escaneados: ${scanned}`);
  console.log(`Documentos candidatos a migrar: ${candidates}`);

  if (dryRun) {
    console.log("DRY_RUN=true → no se escribirá en Firestore.");
    updates.slice(0, 10).forEach((item, index) => {
      console.log(`${index + 1}. ${item.id} -> ${JSON.stringify(item.payload)}`);
    });
    return;
  }

  let written = 0;
  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach((item) => {
      const ref = db.collection(COLLECTION_NAME).doc(item.id);
      batch.set(ref, item.payload, { merge: true });
    });

    await batch.commit();
    written += chunk.length;
    console.log(`✔ Batch ${Math.floor(i / BATCH_LIMIT) + 1}: ${chunk.length} docs`);
  }

  console.log(`✔ Total migrados: ${written}`);
};

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
