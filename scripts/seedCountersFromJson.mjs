import fs from "fs";
import path from "path";
import process from "process";
import admin from "firebase-admin";

const JSON_PATH =
  process.env.JSON_PATH ||
  process.argv[2] ||
  "Data/codigos_historicos.json";

const DRY_RUN =
  String(process.env.DRY_RUN ?? "true").toLowerCase() === "true";

// 🔑 REGEX CORRECTO
const CODE_REGEX = /^HA(\d+)([A-Z])(\d{3})\//i;

const loadServiceAccount = () => {
  if (process.env.GCP_SA_KEY) {
    return JSON.parse(process.env.GCP_SA_KEY);
  }
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
    total++;

    const code =
      typeof item === "string"
        ? item
        : item?.codigo || item?.code || "";

    if (!code) continue;

    const match = String(code).toUpperCase().match(CODE_REGEX);
    if (!match) continue;

    matched++;

    const provider = match[1];
    const type = match[2];
    const seq = Number(match[3]);

    if (!Number.isFinite(seq)) continue;

    const key = `prov${provider}_tipo${type}`;
    const current = counters.get(key) ?? 0;

    counters.set(key, Math.max(current, seq));
  }

  console.log("Resumen detectado:");
  for (const [key, value] of counters.entries()) {
    console.log(`- ${key} => ${value}`);
  }

  console.log(`Total registros: ${total}`);
  console.log(`Códigos válidos: ${matched}`);

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
  console.log(`✔ Counters escritos: ${counters.size}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
