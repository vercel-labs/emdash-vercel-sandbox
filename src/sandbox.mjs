import { APIError, Sandbox } from '@vercel/sandbox';

import { OwnershipError } from './errors.mjs';

const MANAGED_TAG = 'emdash-sandbox-launcher';

export function ownershipTags(stateId) {
  return {
    managedBy: MANAGED_TAG,
    stateId,
    purpose: 'emdash-remote-project'
  };
}

export function isNotFoundError(error) {
  return error instanceof APIError && error.response.status === 404;
}

export async function getSandbox(state, credentials, { resume = false, signal } = {}) {
  if (credentials.teamId !== state.teamId || credentials.projectId !== state.projectId) throw new OwnershipError('Credential scope differs from launcher state');
  const sandbox = await Sandbox.get({
    name: state.name,
    resume: false,
    signal,
    ...credentials
  });
  assertOwnedSandbox(sandbox, state);
  if (resume && sandbox.status !== 'running') {
    const resumed = await Sandbox.get({name:state.name,resume:true,signal,...credentials});
    assertOwnedSandbox(resumed,state);
    return resumed;
  }
  return sandbox;
}

export function assertOwnedSandbox(sandbox, state) {
  const tags = sandbox.tags ?? {};
  if (tags.managedBy !== MANAGED_TAG || tags.stateId !== state.id) {
    throw new OwnershipError(`Sandbox ${state.name} exists but is not owned by this launcher state`);
  }
}

export async function deleteOwnedSandbox(state, credentials, signal) {
  let sandbox;
  try {
    sandbox = await getSandbox(state, credentials, { resume: false, signal });
  } catch (error) {
    if (isNotFoundError(error)) return { deleted: false, reason: 'not_found' };
    throw error;
  }
  assertOwnedSandbox(sandbox, state);
  await sandbox.delete({ deleteOrphanSnapshots: true, signal });
  return { deleted: true, reason: 'deleted' };
}
