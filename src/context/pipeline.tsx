import { createContext, useContext, type JSX } from 'solid-js';
import type { usePipeline } from '../hooks/usePipeline';

export type Pipeline = ReturnType<typeof usePipeline>;

const PipelineContext = createContext<Pipeline>();

export function PipelineProvider(props: {
  value: Pipeline;
  children: JSX.Element;
}) {
  return (
    <PipelineContext.Provider value={props.value}>
      {props.children}
    </PipelineContext.Provider>
  );
}

export function usePipelineContext(): Pipeline {
  const ctx = useContext(PipelineContext);
  if (!ctx) {
    throw new Error(
      'usePipelineContext must be used within a <PipelineProvider>',
    );
  }
  return ctx;
}
