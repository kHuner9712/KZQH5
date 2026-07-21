// Generates a minimal valid 2-page PDF for automated testing.
// Output: public/demo/catalogs/test-sample.pdf
// This file is TEST-ONLY and must not be used as production data.
import { writeFileSync } from "node:fs";

const objects = [
  `<</Type/Catalog/Pages 2 0 R>>`,
  `<</Type/Pages/Kids[3 0 R 4 0 R]/Count 2>>`,
  `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 5 0 R/Resources<</Font<</F1 6 0 R>>>>>>`,
  `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 7 0 R/Resources<</Font<</F1 6 0 R>>>>>>`,
  `<</Length 52>>stream\nBT /F1 24 Tf 72 700 Td (TEST PDF - Page 1 of 2) Tj ET\nendstream`,
  `<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>`,
  `<</Length 52>>stream\nBT /F1 24 Tf 72 700 Td (TEST PDF - Page 2 of 2) Tj ET\nendstream`,
];

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let i = 0; i < objects.length; i++) {
  offsets.push(pdf.length);
  pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
}
const xrefOffset = pdf.length;
pdf += `xref\n0 ${objects.length + 1}\n`;
pdf += `0000000000 65535 f \n`;
for (let i = 1; i <= objects.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`;

writeFileSync("public/demo/catalogs/test-sample.pdf", pdf, "latin1");
console.log(`Generated test-sample.pdf (${pdf.length} bytes, 2 pages)`);
