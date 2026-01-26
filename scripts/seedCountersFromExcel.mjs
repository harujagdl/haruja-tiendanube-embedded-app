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

const CODE_PATTERN = /^HA(\d+)([A-Z])(\d{3})\/([A-Z0-9]+)-([A-Z0-9]+)$/;

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

const parseBoolean = (value, defaultValue) => {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }
  return ['true', '1', 'yes', 'y'].includes(String(value).trim().toLowerCase());
};

const parseArgs = () => {
  const args = process.argv.slice(2);
  const options = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run' || arg === '--dryRun') {
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        options.dryRun = next;
        index += 1;
      } else {
        options.dryRun = 'true';
      }
    }
    if (arg === '--excel' || arg === '--excelPath') {
      const next = args[index + 1];
      if (next && !next.startsWith('--')) {
        options.excelPath = next;
        index += 1;
      }
    }
  }

  return options;
};

const findDefaultXlsxPath = (explicitPath) => {
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
  const invalidRows = [];
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

      const normalized = rawCode.toUpperCase();
      const match = normalized.match(CODE_PATTERN);
      if (!match) {
        invalidRows.push({
          sheet: sheetName,
          row: rowIndex + 1,
          code: rawCode,
          reason: 'Formato inválido',
        });
        continue;
      }

      const providerCode = match[1];
      const typeCode = match[2];
      const seqNumber = Number(match[3]);
      if (!Number.isFinite(seqNumber)) {
        invalidRows.push({
          sheet: sheetName,
          row: rowIndex + 1,
          code: rawCode,
          reason: 'Secuencia inválida',
        });
        continue;
      }

      validCodes += 1;
      const key = `prov${providerCode}_tipo${typeCode}`;
      const existing = counters.get(key) ?? {
        value: 0,
        totalCodesSeen: 0,
        sampleLastCode: '',
      };

      const updated = {
        ...existing,
        totalCodesSeen: existing.totalCodesSeen + 1,
      };

      if (seqNumber >= existing.value) {
        updated.value = seqNumber;
        updated.sampleLastCode = normalized;
      }

      counters.set(key, updated);
    }
  });

  return { counters, invalidRows, totalRows, validCodes };
};

const main = async () => {
  const args = parseArgs();
  const dryRun = parseBoolean(args.dryRun ?? process.env.DRY_RUN, true);
  const xlsxPath = findDefaultXlsxPath(
    args.excelPath ?? process.env.EXCEL_PATH ?? process.env.PRENDAS_XLSX,
  );

  if (!xlsxPath || !fs.existsSync(xlsxPath)) {
    throw new Error(
      `No existe el archivo Excel. Define EXCEL_PATH/PRENDAS_XLSX o guarda ${DEFAULT_XLSX_FILENAME} en /Data.`,
    );
  }

  const workbook = xlsx.readFile(xlsxPath, { cellDates: true });
  const { counters, invalidRows, totalRows, validCodes } = parseWorkbook(workbook);

  if (!counters.size) {
    throw new Error('No se encontraron códigos válidos para generar counters.');
  }

  const sortedKeys = Array.from(counters.keys()).sort();
  console.log('Resumen de counters detectados:');
  for (const key of sortedKeys) {
    const entry = counters.get(key);
    console.log(`- ${key}: value=${entry.value} sample=${entry.sampleLastCode}`);
  }

  console.log('---');
  console.log(`totalRows: ${totalRows}`);
  console.log(`validCodes: ${validCodes}`);
  console.log(`invalidCodes: ${invalidRows.length}`);
  console.log(`keysFound: ${sortedKeys.join(', ')}`);

  if (invalidRows.length) {
    console.log('invalidRows (top 10):');
    invalidRows.slice(0, 10).forEach((invalid) => {
      console.log(
        `- [${invalid.sheet} row ${invalid.row}] ${invalid.code} -> ${invalid.reason}`,
      );
    });
  }

  if (dryRun) {
    console.log('DRY_RUN=true. No se escribieron datos en Firestore.');
    return;
  }

  const serviceAccount = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: process.env.FIREBASE_PROJECT_ID,
  });

  const db = admin.firestore();
  const batch = db.batch();

  for (const [key, entry] of counters.entries()) {
    const counterRef = db.collection('counters').doc(key);
    batch.set(
      counterRef,
      {
        value: entry.value,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        source: 'seed-excel',
        totalCodesSeen: entry.totalCodesSeen,
        sampleLastCode: entry.sampleLastCode,
      },
      { merge: true },
    );
  }

  await batch.commit();

  console.log(`Seed completado. Counters escritos: ${counters.size}`);
};

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
