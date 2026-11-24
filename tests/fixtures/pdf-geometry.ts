import { degrees, PDFDocument, StandardFonts } from "pdf-lib";

export async function createGeometryPdf(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Courier);

  for (const rotation of [0, 90, 180, 270]) {
    const page = document.addPage([300, 200]);
    page.setCropBox(30, 40, 200, 100);
    page.setRotation(degrees(rotation));
    page.drawText("Ag", { x: 70, y: 90, size: 20, font });
  }

  return document.save();
}
