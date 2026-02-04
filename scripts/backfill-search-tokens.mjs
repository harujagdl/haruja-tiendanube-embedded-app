import process from "process";
import admin from "firebase-admin";

const COLLECTION_NAME = "HarujaPrendas_2025";
const BATCH_LIMIT = 400;

const normalizeText = (value) =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

const buildTokens = (value) => {
  const normalized = normalizeText(value);
  const tokens = normalized.split(/[^a-z0-9]+/i).filter(Boolean);
  return [...new Set(tokens)];
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = { dryRun: false };
  args.forEach((arg) => {
    if (arg === "--dry-run" || arg === "--dryRun") {
      result.dryRun = true;
    }
  });
  return result;
};

const run = async () => {
  const { dryRun } = parseArgs();
  if (!admin.apps.length) {
    admin.initializeApp();
  }
  const db = admin.firestore();
  let lastDoc = null;
  let processed = 0;

  while (true) {
    let queryRef = db.collection(COLLECTION_NAME).orderBy(admin.firestore.FieldPath.documentId());
    if (lastDoc) {
      queryRef = queryRef.startAfter(lastDoc);
    }
    queryRef = queryRef.limit(BATCH_LIMIT);

    const snapshot = await queryRef.get();
    if (snapshot.empty) break;

    const batch = db.batch();
    snapshot.docs.forEach((docSnap) => {
      const data = docSnap.data() || {};
      const codigo = String(data.codigo || data.code || docSnap.id || "").trim();
      const descripcion = String(data.descripcion || data.detalles || "").trim();
      const codigoLower = normalizeText(codigo);
      const descripcionLower = normalizeText(descripcion);
      const searchTokens = buildTokens(descripcionLower);
      if (!dryRun) {
        batch.set(
          docSnap.ref,
          { codigoLower, descripcionLower, searchTokens },
          { merge: true }
        );
      }
    });

    if (!dryRun) {
      await batch.commit();
    }
    processed += snapshot.docs.length;
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    console.log(`Procesados ${processed} documentos...`);
  }

  console.log(
    dryRun
      ? `Simulación completa. Documentos leídos: ${processed}.`
      : `Backfill completo. Documentos actualizados: ${processed}.`
  );
};

run().catch((error) => {
  console.error("Error en backfill de searchTokens:", error);
  process.exitCode = 1;
});
