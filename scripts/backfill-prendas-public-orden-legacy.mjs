import process from "process";
import admin from "firebase-admin";

const PUBLIC_COLLECTION = "HarujaPrendas_2025_public";
const BATCH_LIMIT = 350;

const FORCE_PATCH_BY_DOC_ID = {
  "HACJ001_NG-L": {
    proveedorCodigo: "C",
    proveedorNombre: "Molet",
    tipoCodigo: "J",
    tipoNombre: "Trajes de baño",
    color: "NG",
    colorNombre: "Negro",
    talla: "L",
    tallaNombre: "L"
  }
};

const parseBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const safeString = (value) => (value == null ? "" : String(value));

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

const parseNameFromOptionText = (text) => {
  const rawText = safeString(text).trim();
  if (!rawText) return "";
  const parsed = rawText.split(" - ").slice(1).join(" - ").trim();
  return parsed || rawText;
};

const toNumberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const buildFixPayload = (docId, data, fallbackOrden) => {
  const forced = FORCE_PATCH_BY_DOC_ID[docId] || {};
  const providerCode = safeString(
    forced.proveedorCodigo ?? data.providerCode ?? data.proveedorCodigo ?? data.proveedor ?? ""
  ).trim();
  const providerName = safeString(
    forced.proveedorNombre ?? data.providerName ?? data.proveedorNombre ?? ""
  ).trim() || parseNameFromOptionText(data.proveedorLabel);

  const typeCode = safeString(
    forced.tipoCodigo ?? data.typeCode ?? data.tipoCodigo ?? data.tipo ?? ""
  ).trim();
  const typeName = safeString(
    forced.tipoNombre ?? data.typeName ?? data.tipoNombre ?? ""
  ).trim() || parseNameFromOptionText(data.tipoLabel);

  const colorCode = safeString(forced.color ?? data.colorCode ?? data.color ?? "").trim();
  const colorName = safeString(forced.colorNombre ?? data.colorName ?? data.colorNombre ?? "").trim() || parseNameFromOptionText(data.colorLabel);

  const tallaCode = safeString(forced.talla ?? data.tallaCode ?? data.talla ?? "").trim();
  const tallaName = safeString(forced.tallaNombre ?? data.tallaName ?? data.tallaNombre ?? "").trim() || parseNameFromOptionText(data.tallaLabel);

  const orden = toNumberOrNull(data.orden ?? data.seqNumber) ?? fallbackOrden;

  return {
    orden,
    seqNumber: orden,
    providerCode,
    providerName,
    typeCode,
    typeName,
    colorCode,
    colorName,
    tallaCode,
    tallaName,
    proveedor: providerCode,
    proveedorCodigo: providerCode,
    proveedorNombre: providerName,
    tipo: typeCode,
    tipoCodigo: typeCode,
    tipoNombre: typeName,
    color: colorCode,
    colorNombre: colorName,
    talla: tallaCode,
    tallaNombre: tallaName,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    migratedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
};

const main = async () => {
  const dryRun = parseBoolean(process.env.DRY_RUN ?? "true", true);
  const targetDocId = safeString(process.env.TARGET_DOC_ID).trim();
  const db = initFirestore();

  const snap = targetDocId
    ? await db.collection(PUBLIC_COLLECTION).where(admin.firestore.FieldPath.documentId(), "==", targetDocId).get()
    : await db.collection(PUBLIC_COLLECTION).get();

  if (snap.empty) {
    console.log("Sin documentos para migrar.");
    return;
  }

  let maxOrden = 0;
  snap.forEach((docSnap) => {
    const orden = toNumberOrNull(docSnap.data()?.orden ?? docSnap.data()?.seqNumber);
    if (Number.isFinite(orden)) maxOrden = Math.max(maxOrden, orden);
  });

  const updates = [];
  snap.docs.forEach((docSnap, index) => {
    const data = docSnap.data() || {};
    const hasMissing =
      !Number.isFinite(toNumberOrNull(data.orden)) ||
      !Number.isFinite(toNumberOrNull(data.seqNumber)) ||
      !safeString(data.proveedorCodigo).trim() ||
      !safeString(data.proveedorNombre).trim() ||
      !safeString(data.tipoCodigo).trim() ||
      !safeString(data.tipoNombre).trim();

    if (!hasMissing) return;

    const payload = buildFixPayload(docSnap.id, data, maxOrden + index + 1);
    updates.push({ id: docSnap.id, payload });
  });

  console.log(`Docs revisados: ${snap.size}`);
  console.log(`Docs a corregir: ${updates.length}`);

  if (dryRun) {
    console.log("DRY_RUN=true -> solo vista previa.");
    updates.slice(0, 10).forEach(({ id, payload }, i) => {
      console.log(`${i + 1}. ${id} => ${JSON.stringify(payload)}`);
    });
    return;
  }

  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();
    chunk.forEach(({ id, payload }) => {
      batch.set(db.collection(PUBLIC_COLLECTION).doc(id), payload, { merge: true });
    });
    await batch.commit();
    console.log(`✔ Batch ${Math.floor(i / BATCH_LIMIT) + 1}: ${chunk.length} docs`);
  }

  console.log("Migración completada.");
};

main().catch((error) => {
  console.error("Error:", error?.message || error);
  process.exit(1);
});
