// Tipos para el generador de QR vendado (RSQR, sin dependencias).
export interface QROptions {
  ecl?: 'L' | 'M' | 'Q' | 'H';
  version?: number;
  mask?: number;
  margin?: number;
  size?: number;
  dark?: string;
  light?: string;
}
export interface QRMatrix {
  size: number;
  version: number;
  mask: number;
  modules: number[][];
}
export declare const RSQR: {
  version: string;
  svg(text: string, opts?: QROptions): string;
  makeMatrix(text: string, opts?: QROptions): QRMatrix;
};
export default RSQR;
