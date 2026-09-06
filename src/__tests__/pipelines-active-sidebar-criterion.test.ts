import { describe, it, expect } from 'vitest';
import { isActiveSidebarEntry } from '../components/common/sidebar-utils';

describe('isActiveSidebarEntry', () => {
  it('returns true when project is streaming', () => {
    expect(isActiveSidebarEntry({ isStreaming: true, phaseStatus: '' })).toBe(true);
  });

  it('returns true when phaseStatus is running (no streaming)', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'running' })).toBe(true);
  });

  it('returns false when phaseStatus is paused', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'paused' })).toBe(false);
  });

  it('returns false when phaseStatus is interrupted', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'interrupted' })).toBe(false);
  });

  it('returns false when phaseStatus is failed', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'failed' })).toBe(false);
  });

  it('returns false when phaseStatus is aborted', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'aborted' })).toBe(false);
  });

  it('returns false when phaseStatus is done', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'done' })).toBe(false);
  });

  it('returns false when phaseStatus is pipeline-completed', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'pipeline-completed' })).toBe(
      false,
    );
  });

  it('returns false when phaseStatus is idle', () => {
    expect(isActiveSidebarEntry({ isStreaming: false, phaseStatus: 'idle' })).toBe(false);
  });
});
