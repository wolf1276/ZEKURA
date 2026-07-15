import { Buffer } from 'node:buffer';

const HEX32_RE = /^[0-9a-f]{64}$/;

export function isHex32(value: unknown): value is string {
  return typeof value === 'string' && HEX32_RE.test(value);
}

export function hexToBytes32(hex: string): Uint8Array {
  if (!isHex32(hex)) {
    throw new Error(`Expected 64 lowercase hex characters (32 bytes), got: ${hex}`);
  }
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function bytes32ToHex(bytes: Uint8Array): string {
  if (bytes.length !== 32) {
    throw new Error(`Expected exactly 32 bytes, got ${bytes.length}`);
  }
  return Buffer.from(bytes).toString('hex');
}
