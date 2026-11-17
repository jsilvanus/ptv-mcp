import { describe, expect, it } from 'vitest';
import { clientNotice } from './oauthRoutes.js';

describe('clientNotice', () => {
  it('escapes the client name', () => {
    const notice = clientNotice(
      '<script>alert(1)</script>',
      'urn:ptv-mcp:client:abc',
      'https://app.example.test/cb',
    );
    expect(notice).not.toContain('<script>');
    expect(notice).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('shows the host the user is sent back to', () => {
    const notice = clientNotice(
      'Editor',
      'urn:ptv-mcp:client:abc',
      'https://app.example.test:8443/cb',
    );
    expect(notice).toContain('Application: <strong>Editor</strong>');
    expect(notice).toContain('sent back to <strong>app.example.test:8443</strong>');
  });

  it('shows the host of a custom-scheme redirect that has one', () => {
    const notice = clientNotice(
      'Cursor',
      'urn:ptv-mcp:client:abc',
      'cursor://anysphere.cursor/callback',
    );
    expect(notice).toContain('sent back to <strong>anysphere.cursor</strong>');
  });

  it('describes a custom-scheme redirect with no host as an app on this device', () => {
    const notice = clientNotice('VS Code', 'urn:ptv-mcp:client:abc', 'vscode:callback');
    expect(notice).toContain('sent back to <strong>vscode: (an app on this device)</strong>');
  });

  it('uses the hostname of a CIMD https client id when the name is null', () => {
    const notice = clientNotice(
      null,
      'https://client.example.test/metadata.json',
      'http://localhost:3000/cb',
    );
    expect(notice).toContain('Application: <strong>client.example.test</strong>');
    expect(notice).toContain('sent back to <strong>localhost:3000</strong>');
  });

  it('falls back to a generic label for a non-URL client id with no name', () => {
    const notice = clientNotice(null, 'urn:ptv-mcp:test-client', 'https://example.test/cb');
    expect(notice).toContain('Application: <strong>an unnamed application</strong>');
  });

  it('escapes a raw redirect value that is not a URL', () => {
    const notice = clientNotice(null, 'urn:ptv-mcp:test-client', '"><img src=x>');
    expect(notice).not.toContain('<img');
  });
});
