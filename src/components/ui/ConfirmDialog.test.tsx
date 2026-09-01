import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@solidjs/testing-library';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('renders nothing when isOpen is false', () => {
    const { container } = render(() => (
      <ConfirmDialog
        isOpen={false}
        title="Test"
        message="Message"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(container.querySelector('dialog')).toBeNull();
  });

  it('renders dialog with title and message when isOpen', () => {
    render(() => (
      <ConfirmDialog
        isOpen={true}
        title="Delete item"
        message="Are you sure?"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText('Delete item')).toBeTruthy();
    expect(screen.getByText('Are you sure?')).toBeTruthy();
  });

  it('calls onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn();
    render(() => (
      <ConfirmDialog
        isOpen={true}
        title="T"
        message="M"
        onConfirm={onConfirm}
        onCancel={vi.fn()}
      />
    ));
    screen.getByTestId('confirm-dialog-confirm').click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when cancel button clicked', () => {
    const onCancel = vi.fn();
    render(() => (
      <ConfirmDialog
        isOpen={true}
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={onCancel}
      />
    ));
    screen.getByText('Cancel').click();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('uses custom labels when provided', () => {
    render(() => (
      <ConfirmDialog
        isOpen={true}
        title="T"
        message="M"
        confirmLabel="Yes, delete"
        cancelLabel="No, keep"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText('Yes, delete')).toBeTruthy();
    expect(screen.getByText('No, keep')).toBeTruthy();
  });

  it('uses default labels when not provided', () => {
    render(() => (
      <ConfirmDialog
        isOpen={true}
        title="T"
        message="M"
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    ));
    expect(screen.getByText('Cancel')).toBeTruthy();
    expect(screen.getByTestId('confirm-dialog-confirm').textContent).toBe(
      'Confirm',
    );
  });
});
