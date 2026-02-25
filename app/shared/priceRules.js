const IVA_RATE = 0.16;

const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const normalizeNineEnding = (value) => Math.ceil(value / 10) * 10 - 1;
const normalizeInputTotal = (value) => {
  const normalized = normalizeNineEnding(value);
  return normalized < value ? normalized + 10 : normalized;
};

export function calcularPrecioConIVA(precioSinIVA) {
  const base = parseFloat(precioSinIVA);
  if (!Number.isFinite(base) || base <= 0) return null;

  const iva = round2(base * IVA_RATE);
  const total = base + iva;
  const precioConIVA = normalizeNineEnding(total);

  return {
    precioSinIVA: base,
    iva,
    precioConIVA
  };
}

export function ajustarDesdePrecioConIVA(precioConIVAIngresado) {
  const precioObjetivoRaw = parseFloat(precioConIVAIngresado);
  if (!Number.isFinite(precioObjetivoRaw) || precioObjetivoRaw <= 0) return null;

  const totalObjetivo = normalizeInputTotal(precioObjetivoRaw);

  let precioSinIVA = 9;
  while (precioSinIVA <= totalObjetivo * 2) {
    const calculado = calcularPrecioConIVA(precioSinIVA);
    if (calculado && calculado.precioConIVA === totalObjetivo) {
      return calculado;
    }
    precioSinIVA += 10;
  }

  const baseAproximada = normalizeNineEnding(totalObjetivo / (1 + IVA_RATE));
  let candidato = Math.max(9, baseAproximada);
  if (candidato % 10 !== 9) {
    candidato = normalizeNineEnding(candidato);
  }

  while (true) {
    const calculado = calcularPrecioConIVA(candidato);
    if (calculado && calculado.precioConIVA >= totalObjetivo) {
      return calculado;
    }
    candidato += 10;
  }
}
