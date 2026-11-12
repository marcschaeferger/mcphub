import type { Request } from 'express';
import type { SystemConfig } from '../types/index.js';
import config from '../config/index.js';
import { resolveInstallBaseUrl } from './installBaseUrl.js';

export const getPublicInstallBaseUrl = (
  req: Request,
  systemConfig?: SystemConfig | null,
): string | undefined => {
  // Express resolves protocol according to the deployment's trust proxy setting.
  const protocol = req.protocol || 'http';
  const host =
    req.headers?.host ||
    (typeof req.get === 'function' ? req.get('host') : undefined) ||
    (req.headers?.[':authority'] as string | undefined);
  return resolveInstallBaseUrl(systemConfig, host ? `${protocol}://${host}` : undefined);
};

/**
 * Public URL of the MCP transport root: origin plus the deployment prefix
 * (the install URL path when one is configured, else BASE_PATH), without a
 * trailing slash. Every resource URI this hub serves starts with it. Empty
 * when neither an install URL nor the request's host is known: no absolute
 * resource then lies under it.
 */
export const getPublicResourceBase = (req: Request, systemConfig?: SystemConfig | null): string => {
  const baseUrl = getPublicInstallBaseUrl(req, systemConfig);
  if (!baseUrl) return '';
  const basePath = (config.basePath || '').replace(/\/+$/, '');
  const publicBase = new URL(baseUrl);
  // Without a configured public URL, the request already contains the deployment prefix.
  const prefix =
    systemConfig?.install?.baseUrl?.trim() || process.env.INSTALL_BASE_URL?.trim()
      ? publicBase.pathname.replace(/\/+$/, '')
      : basePath;
  return `${publicBase.origin}${prefix}`;
};

export const getPublicResourceUrl = (req: Request, systemConfig?: SystemConfig | null): string => {
  const path = (req.originalUrl || req.path || '/').split('?')[0];
  const basePath = (config.basePath || '').replace(/\/+$/, '');
  const resourcePath =
    basePath && path.startsWith(`${basePath}/`) ? path.slice(basePath.length) : path;
  return `${getPublicResourceBase(req, systemConfig)}${resourcePath}`;
};

export const getResourceMetadataUrl = (resource: string): string => {
  const url = new URL(resource);
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}${url.search}`;
};

export const getProtectedResourceUrlFromMetadataRequest = (
  req: Request,
  systemConfig?: SystemConfig | null,
): string | undefined => {
  const baseUrl = getPublicInstallBaseUrl(req, systemConfig);
  if (!baseUrl || !req.params?.resourcePath) return baseUrl;
  const publicBase = new URL(baseUrl);
  const prefix =
    systemConfig?.install?.baseUrl?.trim() || process.env.INSTALL_BASE_URL?.trim()
      ? publicBase.pathname.replace(/\/+$/, '')
      : (config.basePath || '').replace(/\/+$/, '');
  const path = req.path.slice('/.well-known/oauth-protected-resource'.length);
  if (prefix && !path.startsWith(`${prefix}/`)) return undefined;
  const transportPath = path.slice(prefix.length);
  if (
    !/^\/(?:mcp(?:\/.*)?|sse(?:\/.*)?|messages)$/.test(transportPath) &&
    !/^\/[^/]+\/(?:mcp(?:\/.*)?|sse(?:\/.*)?|messages)$/.test(transportPath)
  )
    return undefined;
  return `${publicBase.origin}${path}`;
};
