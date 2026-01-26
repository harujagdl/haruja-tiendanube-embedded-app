import fs from "fs";
import path from "path";
import process from "process";
import admin from "firebase-admin";

const JSON_PATH = process.env.JSON_PATH || process.argv[2] || "Data/codigos_historicos.json";
const DRY_RUN = String(process.env.DRY_RUN ?? "true").toLowerCase() === "true";

/**
 * Parse robusto para históricos mezclados:
 * - Nuevo: HA4A027/AM-M   => prov=4, tipo=A, seq=027
 * - Proveedor 2 dígitos: HA32A001/.. => prov=32, tipo=A, seq=001
 * - Viejo numérico: HA32001/RP-UN => prov=3, tipo=2, seq=001
 *
 * Regla: toma lo que está entre "HA" y "/"
 * - seq = últimos 3
 * - tipo = 1 caracter antes de esos 3
 * - proveedor = el resto al inicio
 */
const parseCodigo = (raw) => {
  const s = String(raw || "").trim().toUpperCase();
  const slash = s.indexOf("/");
  if (!s.startsWith("HA") || slash === -1) return null;

  const body = s.slice(2, slash); // entre HA y /
  if (body.length < 5) return null; // prov(>=1) + tipo(1) + seq(3)

  const seqStr = body.slice(-3);
  const typeCode = body.slice(-4, -3);
  const providerCode = body.slice(0, -4);

  const seq = Number(seqStr);
  if (!providerCode || !typeCode || !Number.isFinite(seq)) return null;

  return { providerCode, typeCode, seq };
};

const loadServiceAccount = () => {
  if (process.env.GCP_SA_KEY) return JSON.parse(process.env.GCP_SA_KEY);
  throw new Error("Falta GCP_SA_KEY en secrets");
};

const main = async () => {
  const fullPath = path.resolve(process.cwd(), JSON_PATH);

  if (!fs.existsSync(fullPath)) {
    throw new Error(`No existe el archivo JSON: ${fullPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));

  const counters = new Map();
  let total = 0;
  let matched = 0;

  const values = Array.isArray(raw) ? raw : Object.values(raw);

  for (const item of values) {
    total += 1;

    // soporta: ["HA..."] o [{codigo:"HA..."}, ...] o [{code:"HA..."}, ...]
    const code = typeof item === "string" ? item : item?.codigo || item?.code || "";
    if (!code) continue;

    const parsed = parseCodigo(code);
    if (!parsed) continue;

    matched += 1;

    const key = `prov${parsed.providerCode}_tipo${parsed.typeCode}`;
    const current = counters.get(key) ?? 0;
    counters.set(key, Math.max(current, parsed.seq));
  }

  console.log("Resumen detectado:");
  const sortedKeys = Array.from(counters.keys()).sort();
  for (const key of sortedKeys) {
    console.log(`- ${key} => ${counters.get(key)}`);
  }

  console.log("---");
  console.log(`Total registros: ${total}`);
  console.log(`Códigos válidos: ${matched}`);
  console.log(`Keys detectadas: ${sortedKeys.length}`);

  if (!counters.size) {
    throw new Error("No se detectaron códigos válidos en el JSON (revisa formato y contenido).");
  }

  if (DRY_RUN) {
    console.log("DRY_RUN=true → no se escribió en Firestore");
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert(loadServiceAccount()),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();
  const batch = db.batch();

  for (const [key, value] of counters.entries()) {
    const ref = db.collection("counters").doc(key);
    batch.set(
      ref,
      {
        value,
        lastNumber: value,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "seed-json",
      },
      { merge: true }
    );
  }

  await batch.commit();
  console.log(`✔ Counters escritos/actualizados: ${counters.size}`);
};

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
