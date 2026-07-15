import { describe, expect, it } from 'vitest';

import { bytes32ToHex, hexToBytes32, isHex32 } from '../../src/utils/hex.js';

describe('hex utils', () => {
  it('round-trips 32 bytes through hex', () => {
    const bytes = new Uint8Array(32).map((_, i) => i);
    const hex = bytes32ToHex(bytes);
    expect(hex).toHaveLength(64);
    expect(hexToBytes32(hex)).toEqual(bytes);
  });

  it('isHex32 accepts exactly 64 lowercase hex chars', () => {
    expect(isHex32('a'.repeat(64))).toBe(true);
    expect(isHex32('A'.repeat(64))).toBe(false); // uppercase rejected
    expect(isHex32('a'.repeat(63))).toBe(false); // too short
    expect(isHex32('a'.repeat(65))).toBe(false); // too long
    expect(isHex32('g'.repeat(64))).toBe(false); // not hex
    expect(isHex32(123)).toBe(false);
  });

  it('hexToBytes32 throws on malformed input', () => {
    expect(() => hexToBytes32('not-hex')).toThrow();
    expect(() => hexToBytes32('ab')).toThrow();
  });

  it('bytes32ToHex throws on wrong length', () => {
    expect(() => bytes32ToHex(new Uint8Array(31))).toThrow();
    expect(() => bytes32ToHex(new Uint8Array(33))).toThrow();
  });
});
