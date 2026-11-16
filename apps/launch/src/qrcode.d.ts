/** The slice of qrcode (untyped) the site uses. */
declare module 'qrcode' {
  const QRCode: { toDataURL(text: string, opts?: { margin?: number; width?: number; errorCorrectionLevel?: 'L' | 'M' | 'Q' | 'H' }): Promise<string> }
  export default QRCode
}
