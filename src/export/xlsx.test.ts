import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, crc32 } from './xlsx.js';

/** The stored ZIP's entries by name, read from the local file headers. */
function entries(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const files = new Map<string, string>();
  for (let offset = 0; view.getUint32(offset, true) === 0x04034b50;) {
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const name = new TextDecoder().decode(zip.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength;
    const data = zip.subarray(start, start + size);
    expect(crc32(data)).toBe(view.getUint32(offset + 14, true));
    files.set(name, new TextDecoder().decode(data));
    offset = start + size;
  }
  return files;
}

describe('xlsx', () => {
  it('computes the standard CRC-32 and column names', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect([0, 25, 26, 27, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AB', 'ZZ', 'AAA']);
  });

  it('writes a workbook with escaped text, numbers and safe sheet names', () => {
    const files = entries(
      buildXlsx([
        {
          name: 'Palvelut',
          rows: [
            ['Nimi', 'Määrä'],
            ['Kaste & <rippikoulu>', 3],
            [null, 4.5],
          ],
        },
        { name: 'Palvelut', rows: [['x']] },
        { name: 'Liitokset/[1]', rows: [] },
      ]),
    );
    expect([...files.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
      'xl/worksheets/sheet3.xml',
    ]);
    expect(files.get('xl/workbook.xml')).toContain(
      '<sheet name="Palvelut" sheetId="1" r:id="rId1"/><sheet name="Palvelut 2" sheetId="2" r:id="rId2"/><sheet name="Liitokset  1 " sheetId="3"',
    );
    const sheet = files.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<t xml:space="preserve">Kaste &amp; &lt;rippikoulu&gt;</t>');
    expect(sheet).toContain('<c r="B2" s="2"><v>3</v></c>');
    expect(sheet).toContain('<row r="3"><c r="B3" s="2"><v>4.5</v></c></row>');
    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
  });
});
