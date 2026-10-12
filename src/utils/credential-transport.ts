/** Transport policy shared by Foundry authentication, REST clients, and setup tools. */
export const CREDENTIAL_TRANSPORT_ERROR =
  'Foundry endpoints require HTTPS; HTTP is allowed only for localhost, 127.0.0.1, or [::1], without URL credentials or fragments.';

/** Reject unsafe endpoints before constructing a client or transmitting credentials. */
export function assertProtectedCredentialTransport(value: string, allowQuery = false): void {
  try {
    // Check the original authority: URL normalizes numeric IPv4 aliases into loopback.
    if (/\s|\\/.test(value)) {
      throw new Error();
    }
    const authority = /^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
    if (!authority || authority.includes('@')) {
      throw new Error();
    }
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      value.includes('#') ||
      (!allowQuery && value.includes('?'))
    ) {
      throw new Error();
    }
    if (url.protocol === 'https:') {
      return;
    }
    const host = authority.replace(/:\d+$/, '').toLowerCase();
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(host)) {
      return;
    }
  } catch {
    // Never include the supplied URL, which may itself contain credentials.
  }
  throw new Error(CREDENTIAL_TRANSPORT_ERROR);
}

/** Safe refinement for configuration and interactive URL validation. */
export function hasProtectedCredentialTransport(value: string): boolean {
  try {
    assertProtectedCredentialTransport(value);
    return true;
  } catch {
    return false;
  }
}
