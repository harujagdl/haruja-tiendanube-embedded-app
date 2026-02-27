import process from "process";
import admin from "firebase-admin";

const COLLECTION_NAME = "HarujaPrendas_2025_admin";
const BATCH_LIMIT = 450;

const parseBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const parseArgs = () => {
  const result = { dryRun: undefined };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry" || arg === "--dry-run" || arg === "--dryRun") {
      result.dryRun = "true";
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

const toNumberOrNull = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(String(value).replace(/[,$\s]/g, ""));
  return Number.isFinite(num) ? num : null;
};

const resolveAvailability = (qtyAvailable) => {
  if (qtyAvailable > 0) {
    return { status: "Disponible", disponibilidad: "Disponible" };
  }
  return { status: "Vendido", disponibilidad: "No disponible" };
};

const main = async () => {
  const args = parseArgs();
  const dryRun = parseBoolean(process.env.DRY_RUN ?? args.dryRun ?? "false", false);
  const db = initFirestore();
  const snap = await db.collection(COLLECTION_NAME).get();

  const updates = [];
  let scanned = 0;

  snap.forEach((docSnap) => {
    scanned += 1;
    const data = docSnap.data() || {};
    const qtyFromCantidad = toNumberOrNull(data.cantidad);
    const hasQtyAvailable = data.qtyAvailable !== undefined && data.qtyAvailable !== null && data.qtyAvailable !== "";
    const qtyRaw = hasQtyAvailable ? data.qtyAvailable : (qtyFromCantidad ?? 1);
    const qtyAvailable = toNumberOrNull(qtyRaw) ?? 1;
    const qtySold = toNumberOrNull(data.qtySold) ?? 0;
    const availability = resolveAvailability(qtyAvailable);

    const payload = {
      qtyAvailable,
      qtySold,
      status: availability.status,
      disponibilidad: availability.disponibilidad,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (
      data.qtyAvailable !== qtyAvailable ||
      data.qtySold !== qtySold ||
      data.status !== availability.status ||
      data.disponibilidad !== availability.disponibilidad
    ) {
      updates.push({ id: docSnap.id, payload });
    }
  });

  console.log(`Colección: ${COLLECTION_NAME}`);
  console.log(`Documentos escaneados: ${scanned}`);
  console.log(`Documentos a actualizar: ${updates.length}`);

  if (dryRun) {
    console.log("DRY_RUN=true → no se escribirá en Firestore.");
    updates.slice(0, 20).forEach((item, index) => {
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
