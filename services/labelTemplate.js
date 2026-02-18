import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GFA_LOGO = readFileSync(path.resolve(__dirname, "../tools/generated/harujagdl_logo.gfa.txt"), "utf8").trim();

export function buildLabelZPL({ sku, price }) {
  return `
^XA
^CI28
^PW406
^LL203
^LH0,0

^FX --- SKU (arriba izquierda, grande) ---
^FO25,20
^A0N,52,52
^FD${sku}^FS

^FX --- PRECIO (abajo izquierda, enorme) ---
^FO25,90
^A0N,96,96
^FD${price}^FS

^FX --- QR (arriba derecha, grande) ---
^FO255,18
^BQN,2,7
^FDMM,A${sku}^FS

^FX --- Logo debajo del QR (mismo GFA) ---
^FO290,165
${GFA_LOGO}
^FS

^XZ
`;
}
