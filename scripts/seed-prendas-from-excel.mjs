import fs from "fs";
import path from "path";
import process from "process";
import admin from "firebase-admin";
import xlsx from "xlsx";

const DEFAULT_EXCEL_PATH = "Data/HarujaPrendas_2025.xlsx";
const COLLECTION_NAME = "HarujaPrendas_2025";
const SOURCE_TAG = "seed-excel-harujaPrendas2025";
const BATCH_LIMIT = 450;

/**
 * Mapeo de encabezados del Excel -> campos Firestore
 * (normalizamos acentos/espacios)
 */
const HEADER_FIELD_MAP = {
  codigo: "code",
  tipo: "tipo",
  color: "color",
  talla: "talla",
  descripcion: "descripcion",
  precio: "precio",
  "iva (16%)": "iva",
  "precio con iv": "precioConIva",
  "precio con iva": "precioConIva",
  "p. venta": "pVenta",
  "p venta": "pVenta",
  "pventa": "pVenta",
  status: "status",
  disponibilidad: "disponibilidad",
  proveedor: "proveedor",
  fecha: "fecha",
  costo: "costo",
  cantidad: "cantidad",
  "costo subt": "costoSubtotal",
  margen: "margen",
};

const normalizeHeader = (value) =>
  String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();

const normalizeCode = (value) => String(value || "").trim().toUpperCase();

/**
 * Firestore NO permite "/" en docId (porque separa rutas).
 * Ej: "HA32001/RP-UN" -> "HA32001__RP-UN"
 */
const makeSafeDocId = (code) => normalizeCode(code).replaceAll("/", "__");

const parseBoolean = (value, defaultValue = true) => {
  if (value === undefined || value === null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(normalized)) return true;
  if (["false", "0", "no", "n"].includes(normalized)) return false;
  return defaultValue;
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const result = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];

    if (arg === "--dry-run" || arg === "--dryRun") {
      const next = args[i + 1];
      result.dryRun = next ?? "true";
      i += 1;
      continue;
    }
    if (arg.startsWith("--dry-run=") || arg.startsWith("--dryRun=")) {
      result.dryRun = arg.split("=")[1];
      continue;
    }

    if (arg === "--excel" || arg === "--excelPath") {
      const next = args[i + 1];
      if (next) {
        result.excelPath = next;
        i += 1;
      }
      continue;
    }
    if (arg.startsWith("--excel=") || arg.startsWith("--excelPath=")) {
      result.excelPath = arg.split("=")[1];
      continue;
    }
  }

  return result;
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
const parseNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replace(/[,$]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * Parse código Haruja:
 * HA{provider}{type}{seq3}/{color}-{talla}
 * Ej: HA4A027/BG-M
 *
 * provider puede ser 1+ dígitos (ej: 4, 32, 102)
 * type es 1 letra
 * seq es 3 dígitos
 */
const parseCodigo = (raw) => {
  const s = normalizeCode(raw);
  const slash = s.indexOf("/");
  if (!s.startsWith("HA") || slash === -1) return null;

  const body = s.slice(2, slash); // todo antes del /
  if (body.length < 5) return null;

  const seqStr = body.slice(-3);
  const typeCode = body.slice(-4, -3);
  const providerCode = body.slice(0, -4);
  const seqNumber = Number(seqStr);

  if (!providerCode || !typeCode || !Number.isFinite(seqNumber)) return null;
  return { providerCode, typeCode, seqNumber };
};

const formatDateText = (date) => {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = String(date.getFullYear());
  return `${day}/${month}/${year}`;
};

const parseExcelSerialDate = (serial) => {
  const parsed = xlsx.SSF.parse_date_code(serial);
  if (!parsed) return null;
  return new Date(parsed.y, parsed.m - 1, parsed.d);
};

const parseFecha = (value) => {
  if (value === null || value === undefined || value === "") {
    return { fechaAltaTexto: null, fechaAltaDate: null };
  }

  // Si xlsx ya la trajo como Date
  if (value instanceof Date) {
    const date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    return { fechaAltaTexto: formatDateText(date), fechaAltaDate: date };
  }

  // Serial de Excel
  if (typeof value === "number") {
    const date = parseExcelSerialDate(value);
    if (!date) return { fechaAltaTexto: String(value), fechaAltaDate: null };
    const cleanDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    return { fechaAltaTexto: formatDateText(cleanDate), fechaAltaDate: cleanDate };
  }

  const raw = String(value).trim();
  if (!raw) return { fechaAltaTexto: null, fechaAltaDate: null };

  // dd/mm/yyyy o dd-mm-yyyy
  const match = raw.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})$/);
  if (!match) return { fechaAltaTexto: raw, fechaAltaDate: null };

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const date = new Date(year, month - 1, day);

  if (Number.isNaN(date.getTime())) return { fechaAltaTexto: raw, fechaAltaDate: null };
  return { fechaAltaTexto: formatDateText(date), fechaAltaDate: date };
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
  const { dryRun: dryRunArg, excelPath: excelArg } = parseArgs();
  const excelPath = excelArg || process.env.EXCEL_PATH || DEFAULT_EXCEL_PATH;
  const dryRun = parseBoolean(process.env.DRY_RUN ?? dryRunArg ?? "true", true);

  const fullPath = path.resolve(process.cwd(), excelPath);
  if (!fs.existsSync(fullPath)) {
    throw new Error(`No existe el archivo Excel: ${fullPath}`);
  }

  const workbook = xlsx.readFile(fullPath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("El Excel no contiene hojas.");

  const sheet = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(sheet, {
    header: 1,
    defval: null,
    raw: true,
    blankrows: false,
  });

  if (rows.length < 2) throw new Error("El Excel no contiene filas de datos.");

  // Headers
  const headerRow = rows[0];
  const headerIndexes = new Map();

  headerRow.forEach((header, index) => {
    const normalized = normalizeHeader(header);
    if (!normalized) return;
    const field = HEADER_FIELD_MAP[normalized];
    if (field) headerIndexes.set(field, index);
  });

  const dataRows = rows.slice(1);
  const invalids = [];
  const documents = [];

  dataRows.forEach((row, idx) => {
    if (!Array.isArray(row)) return;
    if (row.every((cell) => cell === null || cell === undefined || cell === "")) return;

    const rowNumber = idx + 2;

    const getValue = (field) => {
      const colIndex = headerIndexes.get(field);
      if (colIndex === undefined) return null;
      return row[colIndex];
    };

    const codeRaw = normalizeCode(getValue("code"));
    if (!codeRaw) {
      invalids.push({ rowNumber, code: null, reason: "Sin Código" });
      return;
    }

    const parsedCode = parseCodigo(codeRaw);
    if (!parsedCode) {
      invalids.push({ rowNumber, code: codeRaw, reason: "Código con formato inválido" });
      return;
    }

    const { fechaAltaTexto, fechaAltaDate } = parseFecha(getValue("fecha"));

    // Si hay algo en fecha pero no se pudo parsear, lo marcamos inválido.
    // (Si prefieres NO invalidar por fecha, te lo cambio.)
    if (fechaAltaTexto && !fechaAltaDate) {
      invalids.push({ rowNumber, code: codeRaw, reason: `Fecha inválida (${fechaAltaTexto})` });
      return;
    }

    const docId = makeSafeDocId(codeRaw);

    const docData = {
      // Mantén "code" como en tu app actual:
      code: codeRaw,
      // Alias útil por claridad:
      codigo: codeRaw,

      docId, // debug
      providerCode: parsedCode.providerCode,
      typeCode: parsedCode.typeCode,
      seqNumber: parsedCode.seqNumber,

      source: SOURCE_TAG,
    };

    const setField = (field, value) => {
      if (value === null || value === undefined || value === "") return;
      docData[field] = value;
    };

    setField("tipo", String(getValue("tipo") ?? "").trim());
    setField("color", String(getValue("color") ?? "").trim());
    setField("talla", String(getValue("talla") ?? "").trim());
    setField("descripcion", String(getValue("descripcion") ?? "").trim());
    const statusRaw = String(getValue("status") ?? "").trim();
    const statusCanon = normalizeStatus(statusRaw);
    if (statusCanon) {
      setField("status", statusCanon);
      setField("statusCanon", statusCanon);
    }
    const disponibilidadRaw = String(getValue("disponibilidad") ?? "").trim();
    const disponibilidadCanon = normalizeDisponibilidad(disponibilidadRaw, statusCanon);
    setField("disponibilidad", disponibilidadCanon);
    setField("disponibilidadCanon", disponibilidadCanon);
    setField("proveedor", String(getValue("proveedor") ?? "").trim());

    if (fechaAltaDate) {
      const cleanFechaAltaDate = new Date(
        fechaAltaDate.getFullYear(),
        fechaAltaDate.getMonth(),
        fechaAltaDate.getDate()
      );
      docData.fechaAltaTexto = fechaAltaTexto; // DD/MM/YYYY
      docData.fechaAlta = admin.firestore.Timestamp.fromDate(cleanFechaAltaDate);
      // Legacy (compatibilidad)
      docData.fechaTexto = fechaAltaTexto;
      docData.fecha = admin.firestore.Timestamp.fromDate(cleanFechaAltaDate);
    }

    const precio = parseNumber(getValue("precio"));
    const iva = parseNumber(getValue("iva"));
    const pVentaRaw = parseNumber(getValue("pVenta"));
    const precioConIvaLegacy = parseNumber(getValue("precioConIva"));

    setField("precio", precio);
    setField("iva", iva);

    const pVenta =
      pVentaRaw ??
      precioConIvaLegacy ??
      (Number.isFinite(precio) ? Number((precio * 1.16).toFixed(2)) : null);
    setField("pVenta", pVenta);

    setField("costo", parseNumber(getValue("costo")));
    setField("cantidad", parseNumber(getValue("cantidad")));
    setField("costoSubtotal", parseNumber(getValue("costoSubtotal")));
    setField("margen", parseNumber(getValue("margen")));

    documents.push({ docId, data: docData });
  });

  console.log(`Archivo: ${excelPath}`);
  console.log(`Filas leídas: ${dataRows.length}`);
  console.log(`Docs válidos: ${documents.length}`);
  console.log(`Docs inválidos: ${invalids.length}`);

  if (invalids.length) {
    console.log("---");
    console.log("Top 10 inválidos:");
    invalids.slice(0, 10).forEach((item, index) => {
      console.log(`${index + 1}. Fila ${item.rowNumber} (${item.code ?? "sin código"}): ${item.reason}`);
    });
  }

  if (dryRun) {
    console.log("---");
    console.log("DRY_RUN=true → no se escribirá en Firestore.");
    console.log("Ejemplo (top 5) docIds a escribir:");
    documents.slice(0, 5).forEach((d) => console.log(`- ${d.docId}  (code=${d.data.code})`));
    return;
  }

  const db = initFirestore();
  const collectionRef = db.collection(COLLECTION_NAME);
  let totalWritten = 0;

  for (let i = 0; i < documents.length; i += BATCH_LIMIT) {
    const chunk = documents.slice(i, i + BATCH_LIMIT);

    const refs = chunk.map((doc) => collectionRef.doc(doc.docId));
    const snapshots = await db.getAll(...refs);

    const batch = db.batch();

    snapshots.forEach((snap, index) => {
      const payload = {
        ...chunk[index].data,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      if (!snap.exists) {
        payload.createdAt = admin.firestore.FieldValue.serverTimestamp();
      }

      batch.set(refs[index], payload, { merge: true });
    });

    await batch.commit();
    totalWritten += chunk.length;
    console.log(`✔ Batch ${Math.floor(i / BATCH_LIMIT) + 1}: ${chunk.length} docs`);
  }

  console.log(`✔ Total escritos/actualizados: ${totalWritten}`);
};

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
