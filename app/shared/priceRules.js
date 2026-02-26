const IVA_RATE = 0.16;

const round2 = (value) => Number((Number(value) || 0).toFixed(2));

export function calcularPrecioConIVA(precioSinIVA) {
  const base = parseFloat(precioSinIVA);
  if (!Number.isFinite(base) || base <= 0) return null;

  const iva = round2(base * IVA_RATE);
  const total = base + iva;
  const precioConIVA = Math.ceil(total / 10) * 10 - 1;

  return {
    precioSinIVA: base,
    iva,
    precioConIVA
  };
}

export function ajustarDesdePrecioConIVA(precioConIVAIngresado) {
  const precioIngresado = parseFloat(precioConIVAIngresado);
  if (!Number.isFinite(precioIngresado) || precioIngresado <= 0) return null;

  const totalObjetivo = Math.ceil(precioIngresado / 10) * 10 - 1;
  const totalMin = totalObjetivo - 10;
  const pMin = totalMin / (1 + IVA_RATE);
  const pMax = totalObjetivo / (1 + IVA_RATE);

  for (let p = Math.floor(pMin); p <= Math.ceil(pMax); p += 1) {
    if (p % 10 !== 9) continue;
    const calculado = calcularPrecioConIVA(p);
    if (calculado && calculado.precioConIVA === totalObjetivo) {
      return calculado;
    }
  }

  const mejorBase = Math.floor(pMax / 10) * 10 + 9;
  return calcularPrecioConIVA(mejorBase);
}
