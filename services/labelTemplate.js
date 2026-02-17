import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const GFA_LOGO = readFileSync(path.resolve(__dirname, "../tools/assets/haruja_logo_gfa.txt"), "utf8").trim();

export function buildLabelZPL({ sku, price }) {
  return `
^XA
^PW406
^LL200
^CI28

^FO20,25
^A0N,40,40
^FDCODIGO$^FS

^FO20,70
^A0N,70,70
^FD${price}^FS

^FO260,20
^BQN,2,5
^FDLA,${sku}^FS

^FO60,150
${GFA_LOGO}
^FS

^XZ
`;
}
