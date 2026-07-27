/**
 * Container runtime abstraction for NanoClaw.
 * All runtime-specific logic lives here so swapping runtimes means changing one file.
 */
import { execSync } from 'child_process';
import os from 'os';

import { CONTAINER_INSTALL_LABEL, CONTAINER_RUNTIME_BIN_CONFIG, ONECLI_URL } from './config.js';
import { log } from './log.js';

/**
 * The container runtime binary name. Podman ships a Docker-compatible CLI, so
 * pointing this at `podman` is enough for the *invocation* to work — the
 * behavioral differences are handled by the rootless helpers below.
 *
 * Sourced from config so it honors .env under the shipped service, not just
 * process.env, and is restricted to known runtimes — this value is interpolated
 * into execSync command strings.
 */
export const CONTAINER_RUNTIME_BIN = CONTAINER_RUNTIME_BIN_CONFIG;

/** Cached runtime probe — `<bin> info` is a process spawn, and we spawn per container. */
let cachedRootlessPodman: boolean | null = null;

/**
 * Is the active runtime *rootless* Podman?
 *
 * Rootful Podman behaves like Docker for our purposes (containers run in the
 * host's user namespace), so only the rootless case needs the workarounds
 * below. `Host.Security.Rootless` is Podman-only; Docker's `info` has no such
 * field and yields an empty string, so this is false for Docker either way.
 */
export function isRootlessPodman(): boolean {
  if (cachedRootlessPodman !== null) return cachedRootlessPodman;
  try {
    const out = execSync(`${CONTAINER_RUNTIME_BIN} info --format '{{.Host.Security.Rootless}}'`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 10000,
    }).trim();
    cachedRootlessPodman = out === 'true';
  } catch {
    // A runtime that can't answer isn't one we should special-case.
    cachedRootlessPodman = false;
  }
  if (cachedRootlessPodman) log.info('Rootless Podman detected — applying rootless container args');
  return cachedRootlessPodman;
}

/** Test seam: drop the memoized probe so a test can re-detect. */
export function resetRuntimeProbe(): void {
  cachedRootlessPodman = null;
}

/**
 * User-namespace args.
 *
 * Under rootless Podman the container's UID 0 maps to the host user and every
 * other UID lands in the unprivileged subuid range (/etc/subuid). The image
 * runs as `node` (UID 1000), which therefore maps to some high host UID with
 * no access to our bind mounts — writes to the session SQLite DB fail with
 * "attempt to write a readonly database".
 *
 * `--userns=keep-id` maps the host UID to itself inside the container, so the
 * agent process owns the mounted files. Preferred over forcing `--user=0:0`,
 * which would make Claude Code refuse `--dangerously-skip-permissions` (it
 * rejects running as root) and cost us the permission bypass.
 *
 * No-op on Docker, where the host UID already owns the mounts.
 */
export function userNamespaceArgs(): string[] {
  return isRootlessPodman() ? ['--userns=keep-id'] : [];
}

/** Port of the OneCLI gateway when it listens on host loopback, else null. */
function localOnecliPort(): number | null {
  if (!ONECLI_URL) return null;
  try {
    const url = new URL(ONECLI_URL);
    if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) return null;
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

/**
 * CLI args needed for the container to resolve the host gateway.
 *
 * Docker/rootful: `host-gateway` resolves to the host, which is all we need.
 *
 * Rootless Podman is the hard case. Podman auto-injects a `host.docker.internal`
 * hosts entry pointing at the pasta gateway (169.254.1.2), but that address
 * reaches the host's *external* interface — and OneCLI binds to 127.0.0.1, so
 * the credential proxy is unreachable and every agent spawn fails.
 *
 * The fix is two flags that are only useful together:
 *   - `pasta:-T,<port>` forwards that host loopback port into the container,
 *     where it appears on the container's own 127.0.0.1.
 *   - `--add-host` then points the hostname at 127.0.0.1 so the `HTTPS_PROXY`
 *     the OneCLI SDK injects (which uses the *name*) resolves to the forward.
 *
 * Note this deliberately does not use slirp4netns + `allow_host_loopback`, the
 * fix circulating in earlier community patches: Podman 5 made pasta the default
 * and Podman 6 removed slirp4netns entirely, so that approach now hard-errors.
 */
export function hostGatewayArgs(): string[] {
  if (os.platform() !== 'linux') return [];

  if (isRootlessPodman()) {
    const port = localOnecliPort();
    if (port === null) {
      // Remote (or unset) gateway — no loopback to forward. Podman's own
      // host.docker.internal entry already reaches off-host addresses.
      return [];
    }
    return [`--network=pasta:-T,${port}`, '--add-host=host.docker.internal:127.0.0.1'];
  }

  // On Linux, host.docker.internal isn't built-in — add it explicitly
  return ['--add-host=host.docker.internal:host-gateway'];
}

/**
 * Returns CLI args for a readonly bind mount.
 *
 * On SELinux hosts (Fedora/RHEL, where Podman is the default runtime) an
 * unlabeled bind mount is denied inside the container. `:z` relabels the
 * content with a shared SELinux category so the container can read it.
 * Harmless on non-SELinux hosts, but gated on the runtime probe to keep
 * Docker's arguments byte-for-byte unchanged.
 */
export function readonlyMountArgs(hostPath: string, containerPath: string): string[] {
  const opts = isRootlessPodman() && hasSelinux() ? 'ro,z' : 'ro';
  return ['-v', `${hostPath}:${containerPath}:${opts}`];
}

/** Read-write bind mount args, with the same SELinux relabeling as readonly. */
export function readwriteMountArgs(hostPath: string, containerPath: string): string[] {
  return isRootlessPodman() && hasSelinux()
    ? ['-v', `${hostPath}:${containerPath}:z`]
    : ['-v', `${hostPath}:${containerPath}`];
}

/** Is SELinux enforcing/permissive on this host? Cached; false off Linux. */
let cachedSelinux: boolean | null = null;
function hasSelinux(): boolean {
  if (cachedSelinux !== null) return cachedSelinux;
  try {
    const mode = execSync('getenforce', {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    cachedSelinux = mode === 'Enforcing' || mode === 'Permissive';
  } catch {
    cachedSelinux = false;
  }
  return cachedSelinux;
}

/** Stop a container by name. Uses execFileSync to avoid shell injection. */
export function stopContainer(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
    throw new Error(`Invalid container name: ${name}`);
  }
  execSync(`${CONTAINER_RUNTIME_BIN} stop -t 1 ${name}`, { stdio: 'pipe' });
}

/** Ensure the container runtime is running, starting it if needed. */
export function ensureContainerRuntimeRunning(): void {
  try {
    execSync(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    log.debug('Container runtime already running');
  } catch (err) {
    log.error('Failed to reach container runtime', { err });
    console.error('\n╔════════════════════════════════════════════════════════════════╗');
    console.error('║  FATAL: Container runtime failed to start                      ║');
    console.error('║                                                                ║');
    console.error('║  Agents cannot run without a container runtime. To fix:        ║');
    console.error('║  1. Ensure Docker is installed and running                     ║');
    console.error('║  2. Run: docker info                                           ║');
    console.error('║  3. Restart NanoClaw                                           ║');
    console.error('╚════════════════════════════════════════════════════════════════╝\n');
    throw new Error('Container runtime is required but failed to start', {
      cause: err,
    });
  }
}

/**
 * Kill orphaned NanoClaw containers from THIS install's previous runs.
 *
 * Scoped by label `nanoclaw-install=<slug>` so a crash-looping peer install
 * cannot reap our containers, and we cannot reap theirs. The label is
 * stamped onto every container at spawn time — see container-runner.ts.
 */
export function cleanupOrphans(): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        encoding: 'utf-8',
      },
    );
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        stopContainer(name);
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      log.info('Stopped orphaned containers', { count: orphans.length, names: orphans });
    }
  } catch (err) {
    log.warn('Failed to clean up orphaned containers', { err });
  }
}
