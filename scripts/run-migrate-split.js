import fs from "node:fs";
import process from "node:process";
import admin from "firebase-admin";

const SOURCE_COLLECTION = "HarujaPrendas_2025";
const PUBLIC_COLLECTION = "HarujaPrendas_2025_public";
const ADMIN_COLLECTION = "HarujaPrendas_2025_admin";
const BATCH_SIZE = 300;

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
    pVenta: resolvePVentaFromMaster(data),
    precio: toFixedNumber(data.precio),
    precioConIva: toFixedNumber(data.precioConIva ?? data.precioConIVA),
  };

  const orden = resolveOrden(data);
  if (Number.isFinite(orden)) {
    payload.orden = orden;
  }

  return payload;
};

const buildAdminPayloadFromMaster = (data = {}) => ({
  ...buildPublicPayloadFromMaster(data),
  seqNumber: data.seqNumber ?? data.seq ?? data.secuencia ?? null,
  source: data.source ?? SOURCE_COLLECTION,
  providerCode: data.providerCode ?? null,
  typeCode: data.typeCode ?? null,
  createdAt: data.createdAt ?? null,
  updatedAt: data.updatedAt ?? null,
  iva: toFixedNumber(data.iva, 4),
  costo: toFixedNumber(data.costo),
  margen: toFixedNumber(data.margen, 3),
  utilidad: toFixedNumber(data.utilidad),
});

const loadServiceAccount = () => {
  const fromEnvJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.GCP_SA_KEY;
  if (fromEnvJson) {
    return JSON.parse(fromEnvJson);
  }

  const saPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (saPath && fs.existsSync(saPath)) {
    return JSON.parse(fs.readFileSync(saPath, "utf8"));
  }

  throw new Error(
    "No service account found. Set FIREBASE_SERVICE_ACCOUNT_JSON/GCP_SA_KEY or GOOGLE_APPLICATION_CREDENTIALS"
  );
};

const initFirestore = () => {
  const serviceAccount = loadServiceAccount();
  const projectId =
    process.env.FIREBASE_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    serviceAccount.project_id;

  if (!projectId) {
    throw new Error("Missing FIREBASE_PROJECT_ID and project_id in service account");
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId,
    });
  }

  return admin.firestore();
};

const run = async () => {
  const db = initFirestore();
  let read = 0;
  let publicWritten = 0;
  let adminWritten = 0;
  let hasMore = true;
  let lastDoc = null;

  while (hasMore) {
    let query = db
      .collection(SOURCE_COLLECTION)
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(BATCH_SIZE);

    if (lastDoc) {
      query = query.startAfter(lastDoc);
    }

    const snapshot = await query.get();
    if (snapshot.empty) {
      hasMore = false;
      break;
    }

    const batch = db.batch();
    for (const docSnap of snapshot.docs) {
      const source = docSnap.data() || {};
      const publicPayload = buildPublicPayloadFromMaster(source);
      const adminPayload = buildAdminPayloadFromMaster(source);
      publicPayload.docId = publicPayload.docId ?? docSnap.id;
      adminPayload.docId = adminPayload.docId ?? docSnap.id;

      batch.set(db.collection(PUBLIC_COLLECTION).doc(docSnap.id), publicPayload, { merge: true });
      batch.set(db.collection(ADMIN_COLLECTION).doc(docSnap.id), adminPayload, { merge: true });
      read += 1;
      publicWritten += 1;
      adminWritten += 1;
    }

    await batch.commit();
    lastDoc = snapshot.docs[snapshot.docs.length - 1];
    hasMore = snapshot.size === BATCH_SIZE;

    console.log(
      `Chunk OK: read=${read}, publicWritten=${publicWritten}, adminWritten=${adminWritten}, lastDoc=${lastDoc.id}`
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      read,
      publicWritten,
      adminWritten,
      source: SOURCE_COLLECTION,
      publicCollection: PUBLIC_COLLECTION,
      adminCollection: ADMIN_COLLECTION,
    })
  );
};

run().catch((error) => {
  console.error("Migration failed:", error?.message || error);
  process.exit(1);
});
