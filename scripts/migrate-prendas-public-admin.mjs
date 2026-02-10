import process from "process";
import admin from "firebase-admin";

const SOURCE_COLLECTION = "HarujaPrendas_2025";
const PUBLIC_COLLECTION = "HarujaPrendas_2025_public";
const ADMIN_COLLECTION = "HarujaPrendas_2025_admin";
const BATCH_LIMIT = 350;

const PUBLIC_FIELDS = [
  "codigo",
  "descripcion",
  "tipo",
  "color",
  "talla",
  "proveedor",
  "status",
  "statusCanon",
  "disponibilidad",
  "disponibilidadCanon",
  "fecha",
  "fechaTexto",
  "fechaAlta",
  "fechaAltaTexto",
  "precioConIva",
  "pVenta",
  "searchTokens",
  "createdAt"
];

const parseBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
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

const pickPublicPayload = (sourceData, docId) => {
  const payload = { codigo: sourceData.codigo || docId };
  PUBLIC_FIELDS.forEach((field) => {
    if (sourceData[field] !== undefined) {
      payload[field] = sourceData[field];
    }
  });
  payload.migratedAt = admin.firestore.FieldValue.serverTimestamp();
  return payload;
};

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const main = async () => {
  const dryRun = parseBoolean(process.env.DRY_RUN ?? "true", true);
  const db = initFirestore();

  const sourceSnap = await db.collection(SOURCE_COLLECTION).get();
  let scanned = 0;
  let publicCandidates = 0;
  let adminCandidates = 0;
  const updates = [];

  sourceSnap.forEach((docSnap) => {
    scanned += 1;
    const data = docSnap.data() || {};
    const docId = docSnap.id;
    const publicPayload = pickPublicPayload(data, docId);
    publicCandidates += 1;

    const costo = toNumberOrNull(data.costo);
    const adminPayload = Number.isFinite(costo)
      ? {
          costo,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedBy: "migration-script",
        }
      : null;

    if (adminPayload) {
      adminCandidates += 1;
    }

    updates.push({ docId, publicPayload, adminPayload });
  });

  console.log(`Escaneados: ${scanned}`);
  console.log(`Public a escribir: ${publicCandidates}`);
  console.log(`Admin a escribir: ${adminCandidates}`);

  if (dryRun) {
    console.log("DRY_RUN=true -> solo vista previa, sin escrituras.");
    updates.slice(0, 5).forEach((item, index) => {
      console.log(`${index + 1}. ${item.docId}`);
      console.log(`   public: ${JSON.stringify(item.publicPayload)}`);
      if (item.adminPayload) {
        console.log(`   admin: ${JSON.stringify({ costo: item.adminPayload.costo })}`);
      }
    });
    return;
  }

  let writtenPublic = 0;
  let writtenAdmin = 0;

  for (let i = 0; i < updates.length; i += BATCH_LIMIT) {
    const chunk = updates.slice(i, i + BATCH_LIMIT);
    const batch = db.batch();

    chunk.forEach(({ docId, publicPayload, adminPayload }) => {
      batch.set(db.collection(PUBLIC_COLLECTION).doc(docId), publicPayload, { merge: true });
      writtenPublic += 1;
      if (adminPayload) {
        batch.set(db.collection(ADMIN_COLLECTION).doc(docId), adminPayload, { merge: true });
        writtenAdmin += 1;
      }
    });

    await batch.commit();
    console.log(`✔ Batch ${Math.floor(i / BATCH_LIMIT) + 1}: ${chunk.length} docs`);
  }

  console.log(`✔ Public escritos: ${writtenPublic}`);
  console.log(`✔ Admin escritos: ${writtenAdmin}`);
};

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
