declare module "qrcode" {
  export function toDataURL(text: string, options: { errorCorrectionLevel: "M"; margin: number; width: number }): Promise<string>;
}
