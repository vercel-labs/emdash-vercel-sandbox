export function hostActions(host) {
  if (host.status === 'running') return ['connect', 'stop'];
  if (host.status === 'stopped') return ['start', ...(host.canSignIn ? ['login'] : [])];
  if (host.status === 'setup incomplete') return host.canSignIn ? ['retry', 'login'] : ['setup'];
  return ['refresh', ...(host.canSignIn ? ['login'] : [])];
}
export function homeView({ hosts = [], creatingAnother = false, ready = false, signedIn = false }) {
  return { showSetup: !ready && (!hosts.length || creatingAnother), showHosts: hosts.length > 0,
    connectionLabel: hosts.length && !creatingAnother ? 'Saved hosts' : signedIn ? 'Signed in' : 'Sign in to get started' };
}
