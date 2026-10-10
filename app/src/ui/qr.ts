import qrcode from "qrcode-generator";

/** `text` as a QR code in SVG markup, or null when it is longer than a QR code holds. */
export function qrSvgOf(text: string): string | null {
  try {
    const qr = qrcode(0, "L");
    qr.addData(text, "Byte");
    qr.make();
    return qr.createSvgTag({ cellSize: 2, margin: 2, scalable: true });
  } catch {
    return null;
  }
}
