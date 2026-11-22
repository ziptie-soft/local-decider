import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { flavorFromHardware, needsHardwareProbe } from '../src/engine-flavor.ts';
import type { CapabilityResult, HostCapabilities } from '../src/engines/host-capabilities.ts';

const none: CapabilityResult = { status: 'unavailable', evidence: 'none' };

function caps(over: Partial<HostCapabilities> = {}): HostCapabilities {
  return { npu: none, nvidia: none, rocm: none, apple: none, vulkan: none, probedAt: 0, ...over };
}

const linux = { platform: 'linux', arch: 'x64' } as const;

describe('flavor from hardware', () => {
  it('picks rocm for a confirmed ROCm agent and says how to override', () => {
    const choice = flavorFromHardware(
      linux,
      caps({ rocm: { status: 'available', evidence: 'ROCm gfx1150' } }),
    );
    assert.equal(choice.flavor, 'rocm');
    assert.match(choice.reason, /AMD GPU detected \(ROCm gfx1150\)/);
    assert.match(choice.reason, /--flavor/);
  });

  it('picks cuda for NVIDIA, ahead of ROCm', () => {
    const choice = flavorFromHardware(
      linux,
      caps({
        nvidia: { status: 'available', evidence: 'RTX 4090, 24564 MiB' },
        rocm: { status: 'available', evidence: 'ROCm gfx1150' },
      }),
    );
    assert.equal(choice.flavor, 'cuda');
    assert.match(choice.reason, /NVIDIA GPU detected/);
  });

  it('falls back to cpu with no GPU, an unconfirmed GPU, or no probe', () => {
    for (const capabilities of [
      caps(),
      caps({ rocm: { status: 'unknown', evidence: '/dev/kfd present, rocminfo not found' } }),
      undefined,
    ]) {
      const choice = flavorFromHardware(linux, capabilities);
      assert.equal(choice.flavor, 'cpu');
      assert.match(choice.reason, /--flavor/);
    }
  });

  it('picks mlx on Apple Silicon without a probe, and probes only on Linux', () => {
    const choice = flavorFromHardware({ platform: 'darwin', arch: 'arm64' });
    assert.equal(choice.flavor, 'mlx');
    assert.match(choice.reason, /Apple Silicon/);
    assert.equal(needsHardwareProbe({ platform: 'darwin' }), false);
    assert.equal(needsHardwareProbe({ platform: 'linux' }), true);
  });
});
