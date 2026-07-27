import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// Mock os so the Linux-only gateway branches are testable off Linux.
const mockPlatform = vi.fn(() => 'linux');
vi.mock('os', () => ({
  default: { platform: () => mockPlatform() },
  platform: () => mockPlatform(),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  readwriteMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  isRootlessPodman,
  resetRuntimeProbe,
  userNamespaceArgs,
  hostGatewayArgs,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL, ONECLI_URL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
  resetRuntimeProbe();
  mockPlatform.mockReturnValue('linux');
});

/**
 * Make the runtime probe report Docker (no such info field) or rootless Podman.
 * Anything else the code shells out to (getenforce) is reported absent.
 */
function probeReports(runtime: 'docker' | 'rootless-podman'): void {
  mockExecSync.mockImplementation((cmd: unknown) => {
    const c = String(cmd);
    if (c.includes('Host.Security.Rootless')) {
      return runtime === 'rootless-podman' ? 'true\n' : '';
    }
    // SELinux absent on the test host; every other command succeeds silently
    // so this helper doesn't perturb tests that assert on unrelated calls.
    if (c.includes('getenforce')) throw new Error('command not found');
    return '';
  });
}

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    probeReports('docker');
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });

  it('omits the SELinux :z label when SELinux is not enabled', () => {
    probeReports('rootless-podman');
    expect(readonlyMountArgs('/h', '/c')).toEqual(['-v', '/h:/c:ro']);
  });
});

describe('readwriteMountArgs', () => {
  it('returns a plain -v flag on Docker, matching prior behavior', () => {
    probeReports('docker');
    expect(readwriteMountArgs('/h', '/c')).toEqual(['-v', '/h:/c']);
  });
});

// --- Rootless Podman detection ---

describe('isRootlessPodman', () => {
  it('is true when the runtime reports Host.Security.Rootless=true', () => {
    probeReports('rootless-podman');
    expect(isRootlessPodman()).toBe(true);
  });

  it('is false for Docker, whose info has no such field', () => {
    probeReports('docker');
    expect(isRootlessPodman()).toBe(false);
  });

  it('is false when the runtime cannot be probed at all', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('no runtime');
    });
    expect(isRootlessPodman()).toBe(false);
  });

  it('memoizes the probe so we do not spawn a process per container', () => {
    probeReports('rootless-podman');
    isRootlessPodman();
    isRootlessPodman();
    isRootlessPodman();
    const probes = mockExecSync.mock.calls.filter((c) => String(c[0]).includes('Host.Security.Rootless'));
    expect(probes).toHaveLength(1);
  });
});

describe('userNamespaceArgs', () => {
  it('adds --userns=keep-id under rootless Podman so bind mounts stay writable', () => {
    probeReports('rootless-podman');
    expect(userNamespaceArgs()).toEqual(['--userns=keep-id']);
  });

  it('is a no-op on Docker', () => {
    probeReports('docker');
    expect(userNamespaceArgs()).toEqual([]);
  });
});

describe('hostGatewayArgs', () => {
  it('uses host-gateway on Docker/Linux', () => {
    probeReports('docker');
    expect(hostGatewayArgs()).toEqual(['--add-host=host.docker.internal:host-gateway']);
  });

  it('adds nothing off Linux', () => {
    mockPlatform.mockReturnValue('darwin');
    probeReports('docker');
    expect(hostGatewayArgs()).toEqual([]);
  });

  it('forwards the OneCLI loopback port through pasta under rootless Podman', () => {
    probeReports('rootless-podman');
    const args = hostGatewayArgs();
    // Only meaningful when a loopback ONECLI_URL is configured in this env.
    if (ONECLI_URL && /^(https?:\/\/)?(localhost|127\.0\.0\.1|\[::1\])/.test(ONECLI_URL)) {
      expect(args[0]).toMatch(/^--network=pasta:-T,\d+$/);
      expect(args[1]).toBe('--add-host=host.docker.internal:127.0.0.1');
    } else {
      expect(args).toEqual([]);
    }
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('filters ps by the install label so peers are not reaped', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} ps --filter label=${CONTAINER_INSTALL_LABEL} --format '{{.Names}}'`,
      expect.any(Object),
    );
  });

  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce('nanoclaw-group1-111\nnanoclaw-group2-222\n');
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});
