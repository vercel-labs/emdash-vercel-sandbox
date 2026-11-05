# Vercel Sandbox for EmDash

Connect the released EmDash desktop app to a Vercel Sandbox. Run one command, finish Vercel sign-in in your browser, then select the generated connection once in EmDash.

This is an early preview for **Apple Silicon Macs and EmDash 1.2.10**. It bundles Node.js and its dependencies. You do not need Homebrew, a Vercel CLI installation, a repository checkout, or a separate helper app. EmDash itself must already be installed from [its download page](https://emdash.sh/download).

## Set up your host

Run this in Terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/vercel-labs/emdash-vercel-sandbox/v0.1.0-preview.1/install.sh | sh
```

The installer downloads a versioned CLI bundle, checks its SHA-256, installs a private runtime, and opens a local setup page in your browser. You can close Terminal after that page opens. [Inspect the installer](./install.sh) before running it if you prefer.

1. Sign in to Vercel. You need permission to use Sandbox in the team and project you select.
2. Choose your team and search for a project by name. This project owns the Sandbox and its usage. It does not choose the code repository.
3. Review the host name and click **Create host**. Setup generates the keys, prepares the remote runtime, and registers an SSH alias such as `vercel-my-project`.
4. In EmDash, open **Settings → Machines → Add machine → SSH config**, select that alias, save, and connect. Wait for **Connected** and a **Healthy** workspace runtime.

That SSH-config selection is the one manual connection step. Released EmDash remains unchanged. Setup does not edit EmDash's database or install an EmDash plugin.

## Open your code

Use EmDash's **Add Project** flow on the connected machine to clone or open a repository. Setup also prepares `/home/emdash/project` as a small test project. Use the remote terminal or create a task with an available coding agent. Agent sign-in, such as Codex sign-in, is separate from Vercel authorization.

The first-release acceptance is the remote connection. It does not require testing every coding agent.

## Return, start, or stop

Reconnect to the saved machine in EmDash while the host is running. To manage it, run the same installer command again. The browser opens **Your hosts** with your saved account and project. Click **Start host** when stopped, **Stop** when finished, or **Sign in again** if authorization expired.

Closing Terminal or the setup page does not stop the host. Starting a host starts billable compute. The connection runs only while EmDash needs it. Setup and status checks do not automatically start stopped hosts.

A session defaults to **45 minutes**, with **2 vCPU and 4 GB memory**. The launcher keeps up to two filesystem snapshots with a **24-hour expiration**. Save important work to your repository or export it before the recovery deadline. Stopping saves files and ends processes. Starting restores files into new processes, not an interrupted agent turn. A disconnected task can keep running only within its session lifetime.

Vercel Sandbox [usage charges](https://vercel.com/docs/sandbox/pricing) and [plan limits](https://vercel.com/docs/sandbox/limits) apply. Organization authorization or account limits can prevent creation. Setup reports those failures and preserves existing host state.

## Export work or use terminal commands

The same installer accepts CLI arguments after `sh -s --`. For example:

```sh
curl -fsSL https://raw.githubusercontent.com/vercel-labs/emdash-vercel-sandbox/v0.1.0-preview.1/install.sh | sh -s -- --help
```

Use the documented `export --host NAME --destination PATH` command to export a task. Choose a new destination and keep the task idle during export. Terminal task selection requires an interactive stdin, so download the installer to a local file and run `sh install.sh export ...` for interactive commands.

## How installation works

The bundle contains the CLI, checksummed official Node.js 24.14.0, production dependencies and license notices. It installs a versioned runtime under `~/Library/Application Support/Emdash Sandbox/runtimes`. Generated SSH entries refer to that stable copy, so removing the temporary download does not break the connection. Older runtimes remain available for existing entries.

Host state and authorization stay in `~/.local/state/emdash-sandbox/hosts/`. Keep this private directory while using the hosts. Installation preserves existing SSH settings and refuses conflicting host aliases or host keys. Each new host receives a separate Vercel browser authorization. The browser setup service binds to your own machine, and Sandbox resources belong to your Vercel account.

## Verification and support

The underlying connection has previously passed in released EmDash 1.2.10 with workspace-server 0.1.13. This CLI distribution is verified separately through its tests and release installer checks. Fresh-user browser authorization and the complete desktop flow with this release remain pending. Treat this as a preview, not a completed broad rollout.

If setup fails, retain your existing host and use the reported recovery action. [Open an issue](https://github.com/vercel-labs/emdash-vercel-sandbox/issues) with the release version, platform and sanitized error. Do not attach private state, tokens, keys or full logs containing credentials.

## Develop and build a release

Development requires Node.js 24.14.0, pnpm 11.15.0, Python 3, Git and OpenSSH. These are developer requirements, not installer prerequisites.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm test
pnpm run check
```

Download `node-v24.14.0-darwin-arm64.tar.gz` and `SHASUMS256.txt` from [the official Node.js distribution](https://nodejs.org/dist/v24.14.0/). Build into a new output directory and verify the resulting installer:

```sh
pnpm run build:release -- --output ./dist/release --node-archive ./node-v24.14.0-darwin-arm64.tar.gz --checksums ./SHASUMS256.txt
pnpm run test:release -- --archive ./dist/release/emdash-sandbox-darwin-arm64.tar.gz
```

The builder checks the Node archive hash and creates the CLI archive plus `SHA256SUMS`. The installer smoke test uses a local download fixture, an isolated runtime/state directory, and the real bundled executable. Public download verification is a separate release check. Publish both assets under the version pinned in `install.sh`, after review and compatibility checks.

The integration pins Sandbox SDK 3.3.0 and currently uses its internal authentication helpers. SDK upgrades require sign-in, refresh and account-scope compatibility checks. Desktop and workspace-server versions must also remain compatible. Other operating systems are not packaged in this preview.
