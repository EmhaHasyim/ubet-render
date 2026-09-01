import { describe, it, expect } from 'vitest';
import { render } from '@solidjs/testing-library';
import { usePipelineContext, PipelineProvider } from './pipeline';
import { createMockPipeline } from '../components/test-utils';
import type { Pipeline } from './pipeline';

function CaptureChild(props: { onCapture: (p: Pipeline) => void }) {
  const pipeline = usePipelineContext();
  props.onCapture(pipeline);
  return <div>ok</div>;
}

describe('usePipelineContext', () => {
  it('returns the pipeline value when used inside PipelineProvider', () => {
    const mockPipeline = createMockPipeline({
      codec: () => 'h265',
      maxrate: () => '8000k',
    });

    let captured: Pipeline | undefined;
    render(() => (
      <PipelineProvider value={mockPipeline}>
        <CaptureChild
          onCapture={(p) => {
            captured = p;
          }}
        />
      </PipelineProvider>
    ));

    expect(captured).toBe(mockPipeline);
    expect(captured!.codec()).toBe('h265');
    expect(captured!.maxrate()).toBe('8000k');
  });

  it('throws when used outside PipelineProvider', () => {
    let error: Error | undefined;
    const Child = () => {
      try {
        usePipelineContext();
      } catch (e) {
        error = e as Error;
      }
      return <div />;
    };
    render(() => <Child />);
    expect(error).toBeDefined();
    expect(error!.message).toContain('usePipelineContext must be used within');
  });
});
