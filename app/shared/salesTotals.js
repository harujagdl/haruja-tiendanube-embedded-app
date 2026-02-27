export const emptyMonths = (year = new Date().getFullYear()) => {
  const out = {};
  for (let m = 1; m <= 12; m += 1) {
    out[`${year}-${String(m).padStart(2, "0")}`] = 0;
  }
  return out;
};

const clampMonth = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(12, Math.trunc(parsed)));
};

const resolveSalesContext = () => {
  const query = new URLSearchParams(window.location.search);
  const storeId = query.get("storeId") || window.localStorage?.getItem("haruja_tn_store_id") || "";
  return { storeId: String(storeId || "").trim() };
};

const safeJson = async (response) => {
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  const text = await response.text();
  if (!contentType.includes("application/json")) {
    throw new Error(`API no regresó JSON. HTTP ${response.status}. Recibí: ${text.slice(0, 120)}...`);
  }
  return JSON.parse(text || "{}");
};

export async function getMonthlySalesTotal(db, year, month01) { // db se mantiene por compatibilidad de firma
  return getMonthlyTotalFromVentasComisionesSource(db, year, month01);
}

export async function getMonthlyTotalFromVentasComisionesSource(db, year, month01) { // db se mantiene por compatibilidad de firma
  const normalizedYear = Number(year) || new Date().getFullYear();
  const normalizedMonth = String(month01 || "").padStart(2, "0");
  const docId = `${normalizedYear}-${normalizedMonth}`;

  console.log("[salesTotals] docId:", docId);

  const { storeId } = resolveSalesContext();
  if (!storeId) {
    console.log("[salesTotals] exists:", false);
    console.log("[salesTotals] keys:", []);
    return 0;
  }

  const url = new URL("/dashboard/sales-summary", window.location.origin);
  url.searchParams.set("storeId", storeId);
  url.searchParams.set("month", docId);

  const response = await fetch(url.toString(), { method: "GET" });
  const payload = await safeJson(response);
  if (!response.ok || payload?.ok === false) {
    throw new Error(payload?.error || `No fue posible cargar ventas del mes (${response.status}).`);
  }

  const keys = Object.keys(payload || {});
  console.log("[salesTotals] exists:", true);
  console.log("[salesTotals] keys:", keys);

  const total = Number(payload?.totalMes ?? 0);
  console.log("[salesTotals] total obtenido:", Number.isFinite(total) ? total : 0);

  return Number.isFinite(total) ? total : 0;
}

export async function getMonthlySalesMap(db, year, { startMonth = 1, endMonth = 12 } = {}) {
  const normalizedYear = Number(year) || new Date().getFullYear();
  const monthlyTotals = emptyMonths(normalizedYear);
  const start = clampMonth(startMonth, 1);
  const end = clampMonth(endMonth, 12);

  for (let month = start; month <= end; month += 1) {
    const month01 = String(month).padStart(2, "0");
    const key = `${normalizedYear}-${month01}`;
    try {
      monthlyTotals[key] = await getMonthlyTotalFromVentasComisionesSource(db, normalizedYear, month01);
    } catch (error) {
      console.info(`[salesTotals] ${key} no existe → ventas 0`);
      monthlyTotals[key] = 0;
    }
  }

  return monthlyTotals;
}

export async function getMonthlySalesTotals(db, { year } = {}) {
  const monthlyTotals = await getMonthlySalesMap(db, year);
  return { monthlyTotals };
}
