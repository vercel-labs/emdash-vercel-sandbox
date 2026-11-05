import path from 'node:path';

import { UsageError } from './errors.mjs';

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const WORKTREE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STATE_JSON_LIMIT = 64 * 1024;

export function validateSandboxName(value) {
  if (!NAME_PATTERN.test(value) || value.endsWith('-')) {
    throw new UsageError('Sandbox name must be 1-63 lowercase letters, digits, or hyphens and cannot end with a hyphen');
  }
  return value;
}

export function validateWorktreeName(value) {
  if (!WORKTREE_PATTERN.test(value) || value.includes('..')) {
    throw new UsageError('Worktree name must be 1-128 letters, digits, dots, underscores, or hyphens');
  }
  return value;
}

export function validateStateObject(value) {
  if (!value || typeof value !== 'object') throw new UsageError('Invalid state object');
  const required = ['schemaVersion', 'id', 'name', 'teamId', 'projectId', 'bridgeToken'];
  for (const key of required) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      throw new UsageError(`State file is missing valid string field: ${key}`);
    }
  }
  if (value.schemaVersion !== '1') throw new UsageError('Unsupported state schema version');
  if (!['creating','running','stopped','failed','stopping'].includes(value.status)) throw new UsageError('Invalid state status');
  if (!Number.isInteger(value.relayPort) || value.relayPort < 1024 || value.relayPort > 65535) throw new UsageError('Invalid relay port');
  for (const key of ['url','hostPublicKey']) {
    if (typeof value[key] !== 'string' || (value.status === 'running' && !value[key])) throw new UsageError('Missing '+key);
  }
  if (JSON.stringify(value).length > STATE_JSON_LIMIT) throw new UsageError('State file exceeds 64 KiB');
  validateSandboxName(value.name);
  return value;
}

export function validateDestination(value, stateDir) {
  const destination = path.resolve(value);
  if (destination === path.parse(destination).root || destination === path.resolve(stateDir)) {
    throw new UsageError('Export destination cannot be the filesystem root or state directory');
  }
  if (destination.startsWith(path.resolve(stateDir) + path.sep)) {
    throw new UsageError('Export destination cannot be inside the private state directory');
  }
  return destination;
}

export function validateRemoteExportSelection(worktreeName) {
  const members = ['project'];
  if (worktreeName) members.push(`emdash/worktrees/${validateWorktreeName(worktreeName)}`);
  return members;
}
