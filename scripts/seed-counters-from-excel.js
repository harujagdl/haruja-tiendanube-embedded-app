import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import admin from 'firebase-admin';
import xlsx from 'xlsx';

const DEFAULT_XLSX_FILENAME = 'Creación Códigos HARUJA - PRUEBA.xlsx';
const DEFAULT_XLSX_LOCATIONS = [
  path.resolve(process.cwd(), 'Data', DEFAULT_XLSX_FILENAME),
  path.resolve(process.cwd(), '..', 'Data', DEFAULT_XLSX_FILENAME),
];

const CODE_PATTERN = /^HA(\d+)([A-Z])(\d{3})\/([A-Z0-9]+)-([A-Z0-9]+)$/i;

const COLUMN_ALIASES = {
  code: ['codigo', 'código', 'code', 'sku'],
};

const normalizeString = (value = '') =>
  String(value)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const findDefaultXlsxPath = () => {
  const explicitPath = process.env.PRENDAS_XLSX;
  if (explicitPath) {
    return path.resolve(explicitPath);
  }
  return DEFAULT_XLSX_LOCATIONS.find((candidate) => fs.existsSync(candidate));
};

const findHeaderRow = (rows) => {
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const normalized = row.map((cell) => normalizeString(cell)).filter(Boolean);
    if (!normalized.length) continue;
    if (COLUMN_ALIASES.code.some((alias) => normalized.includes(alias))) {
      return { index, headers: row };
    }
  }
  return null;
};

const resolveIndexMap = (headers) => {
  const normalizedHeaders = headers.map((header) => normalizeString(header));
  const indexMap = {};

  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const index = normalizedHeaders.findIndex((header) =>
      aliases.some((alias) => header === alias || header.includes(alias)),
    );
    if (index !== -1) {
      indexMap[field] = index;
    }
  }

  return indexMap;
};

const detectCodeColumn = (rows, startIndex, preferredIndex) => {
  const columnCount = rows.reduce((max, row) => Math.max(max, row?.length ?? 0), 0);
  let bestIndex = preferredIndex ?? null;
  let bestCount = 0;

  for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
    let count = 0;
    for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex += 1) {
      const rawValue = rows[rowIndex]?.[colIndex];
      if (!rawValue) continue;
      const normalized = String(rawValue).trim().toUpperCase();
      if (CODE_PATTERN.test(normalized)) {
        count += 1;
      }
    }
    if (count > bestCount) {
      bestCount = count;
      bestIndex = colIndex;
    }
  }

  return bestCount > 0 ? bestIndex : null;
};

const loadServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  if (process.env.GCP_SA_KEY) {
    return JSON.parse(process.env.GCP_SA_KEY);
  }
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    const credentialsPath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    return JSON.parse(fs.readFileSync(credentialsPath, 'utf8'));
  }

  const localPath = path.resolve(process.cwd(), 'serviceAccount.json');
  if (fs.existsSync(localPath)) {
    return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  }

  const fallbackPath = path.resolve(process.cwd(), '..', 'scripts', 'serviceAccount.json');
  if (fs.existsSync(fallbackPath)) {
    return JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
  }

  throw new Error(
    'Credenciales no encontradas. Usa serviceAccount.json en /scripts o define GCP_SA_KEY/GOOGLE_APPLICATION_CREDENTIALS.',
  );
};

const parseWorkbook = (workbook) => {
  const counters = new Map();
  let totalRows = 0;
  let validCodes = 0;

  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return;

    const rows = xlsx.utils.sheet_to_json(sheet, {
      header: 1,
      defval: '',
      blankrows: false,
    });

    if (!rows.length) return;
    const headerInfo = findHeaderRow(rows);
    const startIndex = headerInfo ? headerInfo.index + 1 : 0;
    const headers = headerInfo ? headerInfo.headers : rows[0];
    const indexMap = headers ? resolveIndexMap(headers) : {};
    const codeIndex = detectCodeColumn(rows, startIndex, indexMap.code);
    if (codeIndex === null) return;

    for (let rowIndex = startIndex; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex];
      if (!row || row.every((cell) => String(cell ?? '').trim() === '')) {
        continue;
      }
      totalRows += 1;

      const rawCode = String(row[codeIndex] ?? '').trim();
      if (!rawCode) {
        continue;
      }

      const match = rawCode.toUpperCase().match(CODE_PATTERN);
      if (!match) {
        continue;
      }

      const providerCode = match[1];
      const typeCode = match[2];
      const seqNumber = Number(match[3]);
      if (!Number.isFinite(seqNumber)) {
        continue;
      }

      validCodes += 1;
      const key = `${providerCode}${typeCode}`;
      const currentMax = counters.get(key) ?? 0;
      if (seqNumber > currentMax) {
        counters.set(key, seqNumber);
      }
    }
  });

  return { counters, totalRows, validCodes };
};

const main = async () => {
  const xlsxPath = findDefaultXlsxPath();

  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    throw new Error(
      `No existe el archivo Excel. Define PRENDAS_XLSX o guarda ${DEFAULT_XLSX_FILENAME} en /Data.`,
    );
  }

  const workbook = xlsx.readFile(xlsxPath, { cellDates: true });
  const { counters, totalRows, validCodes } = parseWorkbook(workbook);

  if (!counters.size) {
    throw new Error('No se encontraron códigos válidos para generar counters.');
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();
  let upserted = 0;

  for (const [key, lastSeq] of counters.entries()) {
    const counterRef = db.collection('counters').doc(key);
    await counterRef.set({ lastSeq }, { merge: true });
    upserted += 1;
  }

  console.log('Seed de counters finalizado.');
  console.log(`Filas leídas: ${totalRows}`);
  console.log(`Códigos válidos: ${validCodes}`);
  console.log(`Counters creados/actualizados: ${upserted}`);
};

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
