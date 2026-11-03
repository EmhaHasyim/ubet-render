import type { JSX } from 'solid-js';
import { usePipeline } from '../hooks/usePipeline';
import { PipelineProvider, type Pipeline } from './pipeline';

export function PipelineBridge(props: {
  children: (pipeline: Pipeline) => JSX.Element;
}) {
  const pipeline = usePipeline();
  return (
    <PipelineProvider value={pipeline}>
      {props.children(pipeline)}
    </PipelineProvider>
  );
}
