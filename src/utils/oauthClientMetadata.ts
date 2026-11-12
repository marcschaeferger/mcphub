// Bounds for RFC 7591 dynamic client registration metadata. The registration
// endpoint is public by default (the MCP spec expects open DCR), and every
// accepted client is persisted to the settings store for up to clientTtl.
// Without type and size checks one anonymous request could persist ~1 MB of
// arbitrary metadata (client_name, contacts, jwks, ...), and a loop of them
// fills the disk / settings file. RFC 7591 §2 lets servers reject metadata.

export const MAX_REDIRECT_URIS = 10;
export const MAX_URI_LENGTH = 2048;
export const MAX_CLIENT_NAME_LENGTH = 200;
export const MAX_CONTACTS = 10;
export const MAX_CONTACT_LENGTH = 320;
export const MAX_JWKS_BYTES = 16 * 1024;
export const MAX_SHORT_VALUE_LENGTH = 64;
export const MAX_LIST_ENTRIES = 10;
export const MAX_SCOPE_LENGTH = 1024;
export const DEFAULT_MAX_DYNAMIC_CLIENTS = 1000;

const TOKEN_ENDPOINT_AUTH_METHODS = ['none', 'client_secret_basic', 'client_secret_post'];

export class ClientMetadataError extends Error {
  constructor(
    readonly error: 'invalid_redirect_uri' | 'invalid_client_metadata',
    message: string,
  ) {
    super(message);
  }
}

const LOOPBACK_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * Redirect URIs must be https, or plain http on a loopback host (RFC 8252 §7.3
 * native-app loopback redirects). Other schemes on "localhost" are rejected.
 */
export const assertValidRedirectUris = (redirectUris: unknown): string[] => {
  if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
    throw new ClientMetadataError(
      'invalid_redirect_uri',
      'redirect_uris is required and must be a non-empty array',
    );
  }
  if (redirectUris.length > MAX_REDIRECT_URIS) {
    throw new ClientMetadataError(
      'invalid_redirect_uri',
      `redirect_uris may contain at most ${MAX_REDIRECT_URIS} entries`,
    );
  }
  for (const uri of redirectUris) {
    if (typeof uri !== 'string' || uri.length > MAX_URI_LENGTH) {
      throw new ClientMetadataError(
        'invalid_redirect_uri',
        `Each redirect URI must be a string of at most ${MAX_URI_LENGTH} characters`,
      );
    }
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new ClientMetadataError('invalid_redirect_uri', `Invalid redirect URI: ${uri}`);
    }
    const isHttps = url.protocol === 'https:';
    const isLoopbackHttp = url.protocol === 'http:' && LOOPBACK_HOST_RE.test(url.hostname);
    if (!isHttps && !isLoopbackHttp) {
      throw new ClientMetadataError('invalid_redirect_uri', `Redirect URI must use HTTPS: ${uri}`);
    }
  }
  return redirectUris as string[];
};

const optionalString = (field: string, value: unknown, maxLength: number): string | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maxLength) {
    throw new ClientMetadataError(
      'invalid_client_metadata',
      `${field} must be a string of at most ${maxLength} characters`,
    );
  }
  return value;
};

const optionalStringArray = (
  field: string,
  value: unknown,
  maxEntries: number,
  maxLength: number,
): string[] | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.length > maxEntries ||
    !value.every((entry) => typeof entry === 'string' && entry.length <= maxLength)
  ) {
    throw new ClientMetadataError(
      'invalid_client_metadata',
      `${field} must be an array of at most ${maxEntries} strings of at most ${maxLength} characters`,
    );
  }
  return value as string[];
};

export interface ValidatedClientMetadata {
  client_name?: string;
  grant_types?: string[];
  response_types?: string[];
  scope?: string;
  token_endpoint_auth_method?: string;
  application_type?: 'web' | 'native';
  contacts?: string[];
  logo_uri?: string;
  client_uri?: string;
  policy_uri?: string;
  tos_uri?: string;
  jwks_uri?: string;
  jwks?: Record<string, unknown>;
}

/**
 * Validate the optional (non redirect_uris) registration metadata. Unknown
 * fields are ignored (never persisted); known fields must have the right type
 * and stay within size bounds.
 */
export const validateClientMetadata = (body: Record<string, unknown>): ValidatedClientMetadata => {
  const metadata: ValidatedClientMetadata = {
    client_name: optionalString('client_name', body.client_name, MAX_CLIENT_NAME_LENGTH),
    grant_types: optionalStringArray(
      'grant_types',
      body.grant_types,
      MAX_LIST_ENTRIES,
      MAX_SHORT_VALUE_LENGTH,
    ),
    response_types: optionalStringArray(
      'response_types',
      body.response_types,
      MAX_LIST_ENTRIES,
      MAX_SHORT_VALUE_LENGTH,
    ),
    scope: optionalString('scope', body.scope, MAX_SCOPE_LENGTH),
    token_endpoint_auth_method: optionalString(
      'token_endpoint_auth_method',
      body.token_endpoint_auth_method,
      MAX_SHORT_VALUE_LENGTH,
    ),
    contacts: optionalStringArray('contacts', body.contacts, MAX_CONTACTS, MAX_CONTACT_LENGTH),
    logo_uri: optionalString('logo_uri', body.logo_uri, MAX_URI_LENGTH),
    client_uri: optionalString('client_uri', body.client_uri, MAX_URI_LENGTH),
    policy_uri: optionalString('policy_uri', body.policy_uri, MAX_URI_LENGTH),
    tos_uri: optionalString('tos_uri', body.tos_uri, MAX_URI_LENGTH),
    jwks_uri: optionalString('jwks_uri', body.jwks_uri, MAX_URI_LENGTH),
  };

  if (
    metadata.token_endpoint_auth_method !== undefined &&
    !TOKEN_ENDPOINT_AUTH_METHODS.includes(metadata.token_endpoint_auth_method)
  ) {
    throw new ClientMetadataError(
      'invalid_client_metadata',
      `Unsupported token_endpoint_auth_method: ${metadata.token_endpoint_auth_method}`,
    );
  }

  if (body.application_type !== undefined && body.application_type !== null) {
    if (body.application_type !== 'web' && body.application_type !== 'native') {
      throw new ClientMetadataError(
        'invalid_client_metadata',
        'application_type must be "web" or "native"',
      );
    }
    metadata.application_type = body.application_type;
  }

  if (body.jwks !== undefined && body.jwks !== null) {
    if (typeof body.jwks !== 'object' || Array.isArray(body.jwks)) {
      throw new ClientMetadataError('invalid_client_metadata', 'jwks must be a JSON object');
    }
    if (Buffer.byteLength(JSON.stringify(body.jwks), 'utf8') > MAX_JWKS_BYTES) {
      throw new ClientMetadataError(
        'invalid_client_metadata',
        `jwks must be at most ${MAX_JWKS_BYTES} bytes`,
      );
    }
    metadata.jwks = body.jwks as Record<string, unknown>;
  }

  return metadata;
};

/**
 * Upper bound on stored dynamically-registered clients. Override with
 * MCPHUB_OAUTH_MAX_DYNAMIC_CLIENTS (0 disables the cap).
 */
export const resolveMaxDynamicClients = (): number => {
  const raw = process.env.MCPHUB_OAUTH_MAX_DYNAMIC_CLIENTS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_MAX_DYNAMIC_CLIENTS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_MAX_DYNAMIC_CLIENTS;
};
