import { describe, it, expect, afterEach } from 'vitest';

import {
  getPlatform,
  isWSL,
  isRoot,
  isHeadless,
  hasSystemd,
  getServiceManager,
  commandExists,
  getNodeVersion,
  getNodeMajorVersion,
  detectContainerRuntime,
  isRootlessPodmanRuntime,
} from './platform.js';

// --- getPlatform ---

describe('getPlatform', () => {
  it('returns a valid platform string', () => {
    const result = getPlatform();
    expect(['macos', 'linux', 'unknown']).toContain(result);
  });
});

// --- isWSL ---

describe('isWSL', () => {
  it('returns a boolean', () => {
    expect(typeof isWSL()).toBe('boolean');
  });

  it('checks /proc/version for WSL markers', () => {
    // On non-WSL Linux, should return false
    // On WSL, should return true
    // Just verify it doesn't throw
    const result = isWSL();
    expect(typeof result).toBe('boolean');
  });
});

// --- isRoot ---

describe('isRoot', () => {
  it('returns a boolean', () => {
    expect(typeof isRoot()).toBe('boolean');
  });
});

// --- isHeadless ---

describe('isHeadless', () => {
  it('returns a boolean', () => {
    expect(typeof isHeadless()).toBe('boolean');
  });
});

// --- hasSystemd ---

describe('hasSystemd', () => {
  it('returns a boolean', () => {
    expect(typeof hasSystemd()).toBe('boolean');
  });

  it('checks /proc/1/comm', () => {
    // On systemd systems, should return true
    // Just verify it doesn't throw
    const result = hasSystemd();
    expect(typeof result).toBe('boolean');
  });
});

// --- getServiceManager ---

describe('getServiceManager', () => {
  it('returns a valid service manager', () => {
    const result = getServiceManager();
    expect(['launchd', 'systemd', 'none']).toContain(result);
  });

  it('matches the detected platform', () => {
    const platform = getPlatform();
    const result = getServiceManager();
    if (platform === 'macos') {
      expect(result).toBe('launchd');
    } else {
      expect(['systemd', 'none']).toContain(result);
    }
  });
});

// --- commandExists ---

describe('commandExists', () => {
  it('returns true for node', () => {
    expect(commandExists('node')).toBe(true);
  });

  it('returns false for nonexistent command', () => {
    expect(commandExists('this_command_does_not_exist_xyz_123')).toBe(false);
  });
});

// --- getNodeVersion ---

describe('getNodeVersion', () => {
  it('returns a version string', () => {
    const version = getNodeVersion();
    expect(version).not.toBeNull();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// --- getNodeMajorVersion ---

describe('getNodeMajorVersion', () => {
  it('returns at least 20', () => {
    const major = getNodeMajorVersion();
    expect(major).not.toBeNull();
    expect(major!).toBeGreaterThanOrEqual(20);
  });
});

// --- detectContainerRuntime ---

describe('detectContainerRuntime', () => {
  const original = process.env.CONTAINER_RUNTIME_BIN;
  afterEach(() => {
    if (original === undefined) delete process.env.CONTAINER_RUNTIME_BIN;
    else process.env.CONTAINER_RUNTIME_BIN = original;
  });

  it('returns a supported runtime', () => {
    delete process.env.CONTAINER_RUNTIME_BIN;
    expect(['docker', 'podman']).toContain(detectContainerRuntime());
  });

  it('honors an explicit CONTAINER_RUNTIME_BIN, matching the host at run time', () => {
    process.env.CONTAINER_RUNTIME_BIN = 'podman';
    expect(detectContainerRuntime()).toBe('podman');
    process.env.CONTAINER_RUNTIME_BIN = 'docker';
    expect(detectContainerRuntime()).toBe('docker');
  });

  it('ignores an unsupported value rather than shelling out to it', () => {
    process.env.CONTAINER_RUNTIME_BIN = 'definitely_not_a_runtime; rm -rf /';
    expect(['docker', 'podman']).toContain(detectContainerRuntime());
  });

  it('prefers docker when both are installed, for backwards compatibility', () => {
    delete process.env.CONTAINER_RUNTIME_BIN;
    if (commandExists('docker')) expect(detectContainerRuntime()).toBe('docker');
  });
});

// --- isRootlessPodmanRuntime ---

describe('isRootlessPodmanRuntime', () => {
  it('is always false for docker, which is never probed as podman', () => {
    expect(isRootlessPodmanRuntime('docker')).toBe(false);
  });

  it('returns a boolean for podman without throwing when it is absent', () => {
    expect(typeof isRootlessPodmanRuntime('podman')).toBe('boolean');
  });
});
