import { render } from '@solidjs/testing-library';
import { createSignal, flush } from 'solid-js';
import { describe, expect, it } from 'vitest';
import { Icon } from './Icon';

describe('Icon', () => {
  it('updates the rendered glyph when the icon prop changes', () => {
    const [icon, setIcon] = createSignal('lucide:play');
    const { container } = render(() => <Icon icon={icon()} />);

    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelector('rect')).toBeNull();

    setIcon('lucide:pause');
    flush();

    expect(container.querySelectorAll('rect')).toHaveLength(2);
  });
});
