import { hostActions, homeView } from './setup-presentation.mjs';
const $ = (id) => document.getElementById(id);
const storageKey = 'emdash-setup-capability';
let capability = location.hash.slice(1);
history.replaceState(null, '', location.pathname + location.search);
try {
  if (capability) sessionStorage.setItem(storageKey, capability);
  else capability = sessionStorage.getItem(storageKey) || '';
} catch { /* The fragment still works when session storage is unavailable. */ }

let state = null;
let creatingAnother = false;
let selectedHost = null;
let signedIn = false;
let offline = true;
let closed = false;
let posting = false;
let operation = null;
let lastAction = null;
let retryAction = null;
let pollTimer;
let stateVersion = 0;
let stateRequest = 0;
let teamsVersion = 0;
let teamsLoaded = false;
let teamsLoading = false;
let projectVersion = 0;
let projectController;
let projectsLoading = false;
let projects = [];
let selectedProject = null;
let nextCursor = null;
let submittedSearch = '';
let hostsSignature = '';
let dismissedReady = '';
let shownError = '';
const validName = (name) => /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(name);
const isBusy = () => posting || Boolean(state?.busy) || ['authorizing', 'creating'].includes(state?.phase);
const locked = () => !capability || offline || closed || isBusy();

async function api(path, body, signal) {
  const response = await fetch('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + capability, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store', credentials: 'omit', redirect: 'error', signal,
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The setup helper returned an unexpected response. Try again.'); }
  if (!response.ok) {
    const error = new Error(typeof result?.error === 'string' ? result.error : 'This step could not finish. Try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function clearError() {
  $('error-panel').hidden = true;
  retryAction = null;
}
function showError(error, retry) {
  $('error-message').textContent = error instanceof TypeError
    ? 'Could not reach the setup helper. Try again. If it has closed, reopen setup from the launcher.'
    : error.message || 'This step could not finish. Try again.';
  retryAction = retry;
  $('retry').hidden = !retry || error.status === 403;
  $('error-panel').hidden = false;
}

function safeAuthUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://vercel.com' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function syncControls() {
  const disabled = locked();
  for (const id of ['cached-login', 'browser-login', 'sign-in-again', 'done', 'another-host', 'new-host', 'back-to-hosts', 'close-helper']) $(id).disabled = disabled;
  $('team').disabled = disabled || teamsLoading || !teamsLoaded;
  $('reload-teams').disabled = disabled || teamsLoading;
  $('search').disabled = disabled || !$('team').value;
  $('search-button').disabled = disabled || !$('team').value || projectsLoading;
  $('load-more').disabled = disabled || projectsLoading;
  $('host-name').disabled = disabled;
  $('create').disabled = disabled || !selectedProject || !validName($('host-name').value);
  $('project-results').disabled = disabled;
  $('refresh-hosts').disabled = closed || !capability || isBusy();
  $('retry').disabled = closed || isBusy();
  $('create-form').hidden = !selectedProject;
  $('alias-preview').textContent = $('host-name').value ? 'SSH host: vercel-' + $('host-name').value : '';
  $('scope-step').setAttribute('aria-busy', String(teamsLoading || projectsLoading || isBusy()));
  renderHosts();
}

function renderHosts() {
  const hosts = Array.isArray(state?.hosts) ? state.hosts : [];
  const signature = JSON.stringify([hosts, locked()]);
  if (signature === hostsSignature) return;
  hostsSignature = signature;
  $('hosts').replaceChildren();
  $('hosts-empty').hidden = hosts.length > 0;
  $('hosts-empty').textContent = !capability ? 'Reopen setup to view your hosts.' : state ? 'No hosts yet. Create your first host here.' : 'Loading hosts…';
  for (const host of hosts) {
    const row = document.createElement('li');
    row.className = 'host-row';
    const top = document.createElement('div');
    top.className = 'host-top';
    const name = document.createElement('span');
    name.className = 'host-name';
    name.textContent = host.name;
    const status = document.createElement('span');
    status.className = host.status === 'running' ? 'host-status running' : 'host-status';
    status.textContent = host.status;
    top.append(name, status);
    const alias = document.createElement('code');
    alias.className = 'host-alias';
    alias.textContent = host.alias;
    const controls = document.createElement('div');
    controls.className = 'host-controls';
    for (const action of hostActions(host)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = controls.childElementCount ? 'small quiet' : 'small primary';
      const label = { connect: 'Connect in EmDash', start: 'Start host', stop: 'Stop', login: 'Sign in again', retry: 'Retry setup', refresh: 'Refresh status', setup: 'Finish setup' }[action];
      button.textContent = label;
      button.setAttribute('aria-label', label + ' ' + host.name);
      button.disabled = locked();
      button.addEventListener('click', () => {
        if (action === 'connect') { selectedHost = host; creatingAnother = false; renderState(); $('ready-heading').scrollIntoView({ block: 'center' }); return; }
        if (action === 'refresh') { clearError(); void refreshState(); return; }
        if (action === 'setup') { creatingAnother = true; selectedHost = null; renderState(); return; }
        if (action === 'retry' && !confirm('Continue setup of ' + host.name + '? This can start compute. Vercel Sandbox charges apply.')) return;
        selectedHost = null;
        dismissedReady = '';
        void runAction('host', { name: host.name, action, ...(action === 'retry' ? { confirm: true } : {}) }, { title: label, message: host.alias });
      });
      controls.append(button);
    }
    const scope = document.createElement('p');
    scope.className = 'hint';
    scope.textContent = host.scope || 'Vercel connection saved for this host';
    const hint = document.createElement('p');
    hint.className = 'hint';
    hint.textContent = host.status === 'running' ? 'Ready. Use this host in EmDash.' : host.status === 'stopped' ? 'Start this host to reconnect. Compute charges apply.' : host.status === 'setup incomplete' ? 'Setup did not finish. Continue with this same host.' : 'Could not confirm remote status. Refresh or renew this host’s sign-in.';
    row.append(top, scope, alias, hint, controls);
    $('hosts').append(row);
  }
}

function renderState() {
  if (!state) { syncControls(); return; }
  const phase = state.phase;
  const busy = isBusy();
  const hostReady = selectedHost && state.hosts?.find(h=>h.name===selectedHost.name&&h.status==='running');
  const readyHost = hostReady || (phase === 'ready' && state.ready && dismissedReady !== state.ready.alias ? state.ready : null);
  const ready = !busy && Boolean(readyHost);
  const view = homeView({ hosts: state.hosts, creatingAnother, ready, signedIn });
  $('connection').textContent = offline ? 'Disconnected' : busy ? 'Working' : view.connectionLabel;
  $('login-step').hidden = signedIn || phase === 'authorizing';
  $('scope-step').hidden = !signedIn || phase === 'authorizing';
  $('cached-login').hidden = !state.cachedLoginAvailable;
  $('browser-login').classList.toggle('primary', !state.cachedLoginAvailable);
  $('ready').hidden = !ready;
  $('setup').hidden = !view.showSetup;
  $('hosts-card').hidden = !view.showHosts;
  $('back-to-hosts').hidden = !state.hosts?.length;
  $('layout').classList.toggle('saved-home', view.showHosts && !view.showSetup);
  $('intro').textContent = view.showHosts && !view.showSetup ? 'Choose your saved host to connect from EmDash.' : 'Sign in once, create a host, and connect from EmDash.';
  if (ready) {
    $('ready-heading').textContent = readyHost.name + ' is ready';
    $('ready-alias').textContent = readyHost.alias;
  }
  $('activity').hidden = !busy;
  if (busy) {
    $('activity-title').textContent = operation?.title || (phase === 'authorizing' ? 'Waiting for Vercel sign-in' : 'Preparing your host');
    $('activity-message').textContent = state.message || operation?.message || (phase === 'authorizing'
      ? 'Continue in Vercel and approve access. This window updates when sign-in completes.'
      : 'Keep this window open while setup finishes. Your hosts will update here.');
  }
  const authUrl = phase === 'authorizing' ? safeAuthUrl(state.authUrl) : null;
  $('auth-link').hidden = !authUrl;
  if (authUrl) $('auth-link').href = authUrl;
  else $('auth-link').removeAttribute('href');
  syncControls();
}

async function refreshState() {
  clearTimeout(pollTimer);
  if (closed || !capability) return;
  const request = ++stateRequest;
  const version = stateVersion;
  try {
    const result = await api('state');
    if (version !== stateVersion || request !== stateRequest || closed) return;
    const wasOffline = offline;
    state = result;
    offline = false;
    signedIn = state.signedIn === true;
    if (wasOffline) clearError();
    if (state.phase === 'error') {
      const message = state.message || 'This step could not finish. Try again.';
      if (shownError !== message) {
        shownError = message;
        showError(new Error(message), lastAction ? retryLastAction : refreshState);
      }
    } else shownError = '';
    if (!state.busy && !['authorizing', 'creating'].includes(state.phase)) operation = null;
    renderState();
    if (signedIn && !teamsLoaded && !teamsLoading && !isBusy() && !($('setup').hidden)) void loadTeams();
    if (isBusy()) pollTimer = setTimeout(refreshState, 1000);
  } catch (error) {
    if (version !== stateVersion || request !== stateRequest || closed) return;
    offline = true;
    showError(error, refreshState);
    $('connection').textContent = 'Disconnected';
    syncControls();
    if (isBusy() && error.status !== 403) pollTimer = setTimeout(refreshState, 1000);
  }
}

function resetProjects() {
  ++projectVersion;
  projectController?.abort();
  projectsLoading = false;
  projects = [];
  selectedProject = null;
  nextCursor = null;
  $('host-name').value = '';
  $('project-list').replaceChildren();
  $('project-results').hidden = true;
  $('load-more').hidden = true;
  $('search-status').textContent = '';
  syncControls();
}

async function loadTeams() {
  if (locked()) return;
  const version = ++teamsVersion;
  teamsLoading = true;
  $('reload-teams').hidden = true;
  syncControls();
  try {
    const result = await api('teams', {});
    if (version !== teamsVersion) return;
    $('team').replaceChildren(new Option('Choose a team', ''));
    for (const team of result.items) $('team').append(new Option(team.name, team.id));
    teamsLoaded = true;
    if (!result.items.length) {
      $('search-status').textContent = 'No teams found. Sign in with an account that has access, or retry.';
      $('reload-teams').hidden = false;
    }
  } catch (error) {
    if (version !== teamsVersion) return;
    $('team').replaceChildren(new Option('Could not load teams', ''));
    $('reload-teams').hidden = false;
    showError(error, loadTeams);
  } finally {
    if (version === teamsVersion) { teamsLoading = false; syncControls(); }
  }
}

function renderProjects() {
  $('project-list').replaceChildren();
  $('project-results').hidden = !projects.length;
  for (const project of projects) {
    const label = document.createElement('label');
    label.className = 'project-option';
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'project';
    radio.value = project.id;
    radio.checked = selectedProject?.id === project.id;
    radio.addEventListener('change', () => {
      selectedProject = project;
      $('host-name').value = project.name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'my-project';
      syncControls();
    });
    const name = document.createElement('span');
    name.textContent = project.name;
    label.append(radio, name);
    $('project-list').append(label);
  }
  $('load-more').hidden = nextCursor === null;
}

async function searchProjects(more = false) {
  if (locked() || !$('team').value || projectsLoading) return;
  if (more && nextCursor === null) return;
  clearError();
  if (!more) { resetProjects(); submittedSearch = $('search').value.trim(); }
  const version = ++projectVersion;
  const teamId = $('team').value;
  const cursor = nextCursor;
  projectController = new AbortController();
  projectsLoading = true;
  $('search-status').textContent = more ? 'Loading more projects…' : 'Searching projects…';
  syncControls();
  try {
    const result = await api('projects', { teamId, search: submittedSearch, ...(more ? { cursor } : {}) }, projectController.signal);
    if (version !== projectVersion || teamId !== $('team').value) return;
    const seen = new Set(projects.map((project) => project.id));
    projects.push(...result.items.filter((project) => !seen.has(project.id)));
    nextCursor = result.next ?? null;
    renderProjects();
    $('search-status').textContent = projects.length
      ? projects.length + ' projects shown' + (nextCursor === null ? '. All results loaded.' : '. Load more to see the next 20.')
      : 'No projects found. Try another name or team.';
    if (more) {
      const options = $('project-list').querySelectorAll('input');
      options[seen.size]?.focus();
    }
  } catch (error) {
    if (version !== projectVersion || error.name === 'AbortError') return;
    $('search-status').textContent = 'Search could not finish. Try again.';
    showError(error, () => searchProjects(more));
  } finally {
    if (version === projectVersion) { projectsLoading = false; syncControls(); }
  }
}

function retryLastAction() {
  if (!lastAction) return;
  if (lastAction[0] === 'create') {
    if (selectedProject) $('create-form').requestSubmit();
    else showError(new Error('Choose a team and project, then select Create host to retry.'));
  } else void runAction(...lastAction);
}

async function runAction(route, body, activity) {
  if (locked()) return;
  clearError();
  shownError = '';
  ++stateVersion;
  clearTimeout(pollTimer);
  posting = true;
  operation = activity;
  lastAction = [route, body, activity];
  if (route === 'create') dismissedReady = '';
  if (route === 'login') {
    ++teamsVersion;
    teamsLoading = false;
    teamsLoaded = false;
    signedIn = false;
    $('team').replaceChildren(new Option('Loading teams…', ''));
    resetProjects();
  } else {
    ++projectVersion;
    projectController?.abort();
    projectsLoading = false;
  }
  renderState();
  try {
    await api(route, body);
    state = { ...state, busy: true, phase: route === 'login' ? 'authorizing' : 'creating', message: undefined, authUrl: undefined };
  } catch (error) {
    showError(error, retryLastAction);
    operation = null;
  } finally {
    posting = false;
    renderState();
    await refreshState();
  }
}

$('retry').addEventListener('click', () => { const retry = retryAction; clearError(); void retry?.(); });
$('cached-login').addEventListener('click', () => runAction('login', { method: 'cached' }, { title: 'Checking Vercel CLI sign-in', message: 'Checking access to your Vercel account.' }));
const browserLogin = () => runAction('login', { method: 'browser' }, { title: 'Sign in to Vercel', message: 'Continue in Vercel and approve access. This window updates when sign-in completes.' });
$('browser-login').addEventListener('click', browserLogin);
$('sign-in-again').addEventListener('click', browserLogin);
$('reload-teams').addEventListener('click', () => { clearError(); void loadTeams(); });
$('team').addEventListener('change', () => {
  clearError();
  lastAction = null;
  resetProjects();
  $('search').value = '';
  $('search-hint').textContent = $('team').value ? 'Search by name, or leave blank to browse. Results load 20 at a time.' : 'Choose a team to search its projects. Results load 20 at a time.';
});
$('search').addEventListener('input', () => { clearError(); lastAction = null; resetProjects(); $('search-status').textContent = 'Press Enter or Search to find projects.'; });
$('search-form').addEventListener('submit', (event) => { event.preventDefault(); void searchProjects(); });
$('load-more').addEventListener('click', () => searchProjects(true));
$('host-name').addEventListener('input', syncControls);
$('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (!selectedProject || !validName($('host-name').value) || locked()) return;
  void runAction('create', { name: $('host-name').value, teamId: $('team').value, projectId: selectedProject.id, confirm: true }, { title: 'Creating your host', message: 'Preparing the Sandbox and SSH connection. This may take a few minutes.' });
});
$('refresh-hosts').addEventListener('click', () => { clearError(); void refreshState(); });
const showHosts = () => { dismissedReady = state?.ready?.alias || ''; selectedHost = null; creatingAnother = false; renderState(); };
$('another-host').addEventListener('click', showHosts);
$('back-to-hosts').addEventListener('click', showHosts);
$('new-host').addEventListener('click', () => {
  dismissedReady = state?.ready?.alias || ''; selectedHost = null; creatingAnother = true; resetProjects(); renderState();
  if (signedIn && !teamsLoaded) void loadTeams();
});
$('close-helper').addEventListener('click', () => $('done').click());
$('done').addEventListener('click', async () => {
  if (locked()) return;
  posting = true;
  syncControls();
  try {
    await api('close', {});
    closed = true;
    clearTimeout(pollTimer);
    ++stateRequest;
    try { sessionStorage.removeItem(storageKey); } catch {}
    capability = '';
    clearError();
    $('connection').textContent = 'Setup closed';
    $('done').textContent = 'Closed';
    $('activity').hidden = true;
    $('ready-heading').textContent = 'Setup closed. You can close this tab.';
    $('intro').textContent = 'Helper closed. You can close this tab. Your host keeps running.';
  } catch (error) { showError(error, () => $('done').click()); }
  finally { posting = false; syncControls(); }
});

if (capability) void refreshState();
else {
  $('connection').textContent = 'Setup link needed';
  $('hosts-empty').textContent = 'Reopen setup to view your hosts.';
  showError(new Error('This setup link is missing its access key. Reopen setup from the launcher to continue.'));
  syncControls();
}
