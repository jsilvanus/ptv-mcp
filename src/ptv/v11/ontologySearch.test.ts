import { describe, expect, it } from 'vitest';
import { OntologySearchUnsupportedError } from '../adapter.js';
import { PtvV11Adapter } from './adapter.js';

describe('PTV v11 ontology term search', () => {
  it('reports that v11 has no ontology endpoint instead of calling PTV', async () => {
    const adapter = new PtvV11Adapter({ environment: 'test' });

    await expect(adapter.searchOntologyTerms({ query: 'kaste' })).rejects.toBeInstanceOf(
      OntologySearchUnsupportedError,
    );
    await expect(adapter.searchOntologyTerms({ query: 'kaste' })).rejects.toThrow(/v12/);
  });
});
