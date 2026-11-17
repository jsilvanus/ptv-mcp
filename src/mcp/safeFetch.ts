import { lookup as dnsLookup } from 'node:dns';
import { request } from 'node:https';
import { isIP } from 'node:net';

function isPrivateIpv4(octets: readonly number[]): boolean {
  const [a, b, c] = octets;
  if (a === undefined || b === undefined || c === undefined) return true;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT, 100.64.0.0/10
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224 // multicast, reserved, broadcast
  );
}

/** The 16 bytes of an IPv6 literal, or null when it does not parse. */
function ipv6Bytes(address: string): number[] | null {
  let text = address.split('%')[0] ?? '';
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const parts = dotted.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return null;
    const [p, q, r, s] = parts as [number, number, number, number];
    text =
      text.slice(0, dotted.index) + ((p << 8) | q).toString(16) + ':' + ((r << 8) | s).toString(16);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes.length === 16 ? bytes : null;
}

/** True for any address a client-metadata fetch must not reach (anything unparseable counts as private). */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address.split('.').map(Number));
  if (family !== 6) return true;
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const first10 = bytes.slice(0, 10).every((byte) => byte === 0);
  const embedded = bytes.slice(12);
  // ::, ::1, IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d (0.x.x.x is private too)
  if (first10 && bytes[10] === bytes[11] && (bytes[10] === 0 || bytes[10] === 0xff))
    return isPrivateIpv4(embedded);
  // NAT64 64:ff9b::/96 embeds an IPv4 address
  if (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b)
    return isPrivateIpv4(embedded);
  const high = bytes[0] ?? 0;
  const second = bytes[1] ?? 0;
  return (
    (high & 0xfe) === 0xfc || // fc00::/7
    (high === 0xfe && (second & 0xc0) === 0x80) || // fe80::/10
    high === 0xff // multicast
  );
}

export interface PinnedResponse {
  status: number;
  location: string | null;
  body: string;
}

/**
 * One HTTPS GET that cannot reach a private address: the connection uses the
 * address this function resolved and checked (no second DNS lookup, so no
 * rebinding), TLS still verifies the hostname, redirects are not followed, and
 * the body is cut off with an error once it exceeds `maxBytes`.
 */
export function fetchPinned(
  url: URL,
  options: { maxBytes: number; timeoutMs: number },
): Promise<PinnedResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: 'GET',
        headers: { accept: 'application/json' },
        timeout: options.timeoutMs,
        lookup: (hostname, lookupOptions, callback) => {
          dnsLookup(hostname, { all: true }, (err, addresses) => {
            if (err) return callback(err, '', 4);
            if (
              addresses.length === 0 ||
              addresses.some(({ address }) => isPrivateAddress(address))
            ) {
              return callback(new Error('CIMD client_id resolves to a private address'), '', 4);
            }
            const [chosen] = addresses as [(typeof addresses)[number]];
            if (lookupOptions.all) {
              return (callback as unknown as (e: null, a: typeof addresses) => void)(null, [
                chosen,
              ]);
            }
            return callback(null, chosen.address, chosen.family);
          });
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            req.destroy(new Error('CIMD document is too large'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            location:
              typeof response.headers.location === 'string' ? response.headers.location : null,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
        response.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('CIMD fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}
