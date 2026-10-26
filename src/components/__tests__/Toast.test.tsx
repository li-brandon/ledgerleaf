// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Toast from '../Toast';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('a replaced toast does not end the new one early', () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = render(<Toast key={1} text="One" onDone={first} ms={1000} />);
  act(() => vi.advanceTimersByTime(600));
  rerender(<Toast key={2} text="Two" onDone={second} ms={1000} />);
  act(() => vi.advanceTimersByTime(600));
  expect(first).not.toHaveBeenCalled();
  expect(second).not.toHaveBeenCalled();
  expect(screen.getByText('Two')).toBeTruthy();
  act(() => vi.advanceTimersByTime(400));
  expect(second).toHaveBeenCalledOnce();
});

it('an unmounted toast never calls onDone', () => {
  const done = vi.fn();
  const { unmount } = render(<Toast text="Gone" onDone={done} ms={1000} />);
  unmount();
  act(() => vi.advanceTimersByTime(2000));
  expect(done).not.toHaveBeenCalled();
});
