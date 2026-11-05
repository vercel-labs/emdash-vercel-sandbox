import fsp from 'node:fs/promises';

import { UsageError } from './errors.mjs';

export async function resolveCredentials({ projectConfig, ignoreEnvironment = false } = {}) {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (!ignoreEnvironment && token && teamId && projectId) {
    return { token, teamId, projectId };
  }
  const projectConfigPath = projectConfig ?? process.env.VERCEL_PROJECT_CONFIG;
  if (!projectConfigPath) {
    throw new UsageError('Set VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID, or set VERCEL_PROJECT_CONFIG to a linked project config');
  }
  let config;
  try {
    config = JSON.parse(await fsp.readFile(projectConfigPath, 'utf8'));
  } catch {
    throw new UsageError('VERCEL_PROJECT_CONFIG is not readable JSON');
  }
  if (typeof config.orgId !== 'string' || typeof config.projectId !== 'string') {
    throw new UsageError('VERCEL_PROJECT_CONFIG must contain orgId and projectId');
  }
  const { getAuth } = await import('@vercel/sandbox/dist/auth/index.js');
  const auth = getAuth();
  if (!auth?.token) throw new UsageError('No cached Vercel credential found for VERCEL_PROJECT_CONFIG');
  return { token: auth.token, teamId: config.orgId, projectId: config.projectId };
}

export function redactResolvedCredentials(text, resolved = {}) {
  const secrets = [
    process.env.AI_GATEWAY_API_KEY,
    process.env.VERCEL_TOKEN,
    resolved.token,
    resolved.gatewayKey,
    resolved.bridgeToken
  ].filter(value => typeof value === 'string' && value.length > 0);
  let output = String(text);
  for (const secret of secrets) output = output.split(secret).join('[redacted]');
  return output;
}
