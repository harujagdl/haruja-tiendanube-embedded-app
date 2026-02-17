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

^FO25,40
^A0N,30,30
^FD${sku}^FS

^FO25,100
^A0N,55,55
^FD${price}^FS

^FO260,20
^BQN,2,6
^FDMM,A${sku}^FS

^FO250,140
${GFA_LOGO}
^FS

^XZ
`;
}
