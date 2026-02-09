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

const normalizeText = (value) =>
  String(value ?? "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const normalizeStatus = (raw) => {
  const normalized = normalizeText(raw);
  if (!normalized) return "";
  if (normalized === "vendido") return "Vendido";
  if (["existente", "en stock", "disponible", "activo"].includes(normalized)) {
    return "Disponible";
  }
  return "";
};

const normalizeDisponibilidad = (raw, statusCanon) => {
  if (statusCanon === "Vendido") return "No disponible";
  const normalized = normalizeText(raw);
  if (!normalized) return "Disponible";
  if (["no disponible", "agotado", "sin stock", "0"].includes(normalized)) {
    return "No disponible";
  }
  if (["disponible", "en stock", "1", "si"].includes(normalized)) {
    return "Disponible";
  }
  return "Disponible";
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
    const currentStatus = data.statusCanon ?? data.status ?? data.Status ?? "";
    const statusCanon = normalizeStatus(currentStatus);
    const currentDisponibilidad = data.disponibilidadCanon ?? data.disponibilidad ?? data.Disponibilidad ?? "";
    const disponibilidadCanon = normalizeDisponibilidad(currentDisponibilidad, statusCanon);

    const payload = {
      statusCanon,
      disponibilidadCanon,
      status: statusCanon,
      disponibilidad: disponibilidadCanon,
    };

    if (
      data.statusCanon !== statusCanon ||
      data.disponibilidadCanon !== disponibilidadCanon ||
      data.status !== statusCanon ||
      data.disponibilidad !== disponibilidadCanon
    ) {
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
