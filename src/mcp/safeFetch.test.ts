import { describe, expect, it } from 'vitest';
import { isPrivateAddress } from './safeFetch.js';

describe('isPrivateAddress', () => {
  it.each([
    '10.0.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '0.0.0.0',
    '100.64.0.1',
    '100.127.255.255',
    '::1',
    '::',
    'fc00::1',
    'fd12::1',
    'fe80::1',
    'febf::1',
    '::ffff:10.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '64:ff9b::a00:1',
    'not-an-ip',
  ])('rejects %s', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '100.63.0.1',
    '100.128.0.1',
    '172.32.0.1',
    '2606:4700::1111',
    '::ffff:8.8.8.8',
  ])('allows %s', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});
