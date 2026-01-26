import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import admin from "firebase-admin";

const DEFAULT_JSON_FILENAME = "codigos_historicos.json";
const DEFAULT_JSON_LOCATIONS = [
  path.resolve(process.cwd(), "Data", DEFAULT_JSON_FILENAME),
  path.resolve(process.cwd(), "..", "Data", DEFAULT_JSON_FILENAME),
];

// HA4A012/CF-XL
const CODE_PATTERN = /^HA(\d+)([A-Z])(\d{3})\//i;

const parseBoolean = (value, defaultValue) => {
  if (value === undefined || value === null || value === "") return defaultValue;
  return ["true", "1", "yes", "y"].includes(String(value).trim().toLowerCase());
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--dry-run" || arg === "--dryRun") {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options.dryRun = next;
        i += 1;
      } else {
        options.dryRun = "true";
      }
      continue;
    }

    if (arg === "--json" || arg === "--jsonPath") {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        options.jsonPath = next;
        i += 1;
      }
    }
  }

  return options;
};

const findDefaultJsonPath = (explicitPath) => {
  if (explicitPath) return path.resolve(explicitPath);
  return DEFAULT_JSON_LOCATIONS.find((candidate) => fs.existsSync(candidate));
};

const loadServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  if (process.env.GCP_SA_KEY) return JSON.parse(process.env.GCP_SA_KEY);

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  }

  const localPath = path.resolve(process.cwd(), "serviceAccount.json");
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, "utf8"));

  const fallbackPath = path.resolve(process.cwd(), "..", "scripts", "serviceAccount.json");
  if (fs.existsSync(fallbackPath)) return JSON.parse(fs.readFileSync(fallbackPath, "utf8"));

  throw new Error(
    "Credenciales no encontradas. Usa serviceAccount.json o define GCP_SA_KEY/GOOGLE_APPLICATION_CREDENTIALS.",
  );
};

const parseCodes = (codes) => {
  const counters = new Map();
  const invalidCodes = [];
  let matchedCodes = 0;

  codes.forEach((rawCode, index) => {
    const code = String(rawCode ?? "").trim().toUpperCase();
    if (!code) return;

    const match = code.match(CODE_PATTERN);
    if (!match) {
      invalidCodes.push({ index: index + 1, code, reason: "Formato inválido" });
      return;
    }

    matchedCodes += 1;
    const providerCode = match[1];
    const typeCode = match[2];
    const seqNumber = Number(match[3]);

    if (!Number.isFinite(seqNumber)) {
      invalidCodes.push({ index: index + 1, code, reason: "Secuencia inválida" });
      return;
    }

    const key = `prov${providerCode}_tipo${typeCode}`;
    const current = counters.get(key) ?? { value: 0, sampleLastCode: "" };
    if (seqNumber >= current.value) {
      counters.set(key, { value: Math.max(current.value, seqNumber), sampleLastCode: code });
    }
  });

  return { counters, invalidCodes, matchedCodes };
};

const main = async () => {
  const args = parseArgs();
  const dryRun = parseBoolean(args.dryRun ?? process.env.DRY_RUN, true);

  const jsonPath = findDefaultJsonPath(args.jsonPath ?? process.env.JSON_PATH);

  if (!jsonPath || !fs.existsSync(jsonPath)) {
    throw new Error(`No existe el JSON. Define JSON_PATH o guarda ${DEFAULT_JSON_FILENAME} en /Data.`);
  }

  const raw = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("El JSON debe ser un array de códigos.");
  }

  const { counters, invalidCodes, matchedCodes } = parseCodes(raw);

  if (!counters.size) {
    throw new Error("No se encontraron códigos válidos para generar counters.");
  }

  const sortedKeys = Array.from(counters.keys()).sort();
  console.log("Resumen de counters detectados:");
  for (const key of sortedKeys) {
    const entry = counters.get(key);
    console.log(`- ${key}: value=${entry.value} sample=${entry.sampleLastCode}`);
  }

  console.log("---");
  console.log(`totalCodes: ${raw.length}`);
  console.log(`matchedCodes: ${matchedCodes}`);
  console.log(`invalidCodes: ${invalidCodes.length}`);
  console.log(`keysGenerated: ${sortedKeys.length}`);
  if (counters.has("prov4_tipoA")) {
    console.log(`example: prov4_tipoA => max=${counters.get("prov4_tipoA").value}`);
  } else if (sortedKeys.length) {
    const exampleKey = sortedKeys[0];
    console.log(`example: ${exampleKey} => max=${counters.get(exampleKey).value}`);
  }

  if (invalidCodes.length) {
    console.log("invalidCodes (top 10):");
    invalidCodes.slice(0, 10).forEach((invalid) => {
      console.log(`- [${invalid.index}] ${invalid.code} -> ${invalid.reason}`);
    });
  }

  if (dryRun) {
    console.log("DRY_RUN=true. No se escribieron datos en Firestore.");
    console.log("docsWritten: 0");
    return;
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
  });

  const db = admin.firestore();
  const batch = db.batch();

  for (const [key, entry] of counters.entries()) {
    const counterRef = db.collection("counters").doc(key);

    batch.set(
      counterRef,
      {
        value: entry.value,
        lastNumber: entry.value,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: "seed-json",
      },
      { merge: true },
    );
  }

  await batch.commit();
  console.log(`Seed completado. Counters escritos: ${counters.size}`);
  console.log(`docsWritten: ${counters.size}`);
};

main().catch((error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
