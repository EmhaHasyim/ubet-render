export const TAURI_COMMANDS = {
  startRender: 'start_render',
  resumeRender: 'resume_render',
  cancelRender: 'cancel_render',
  pauseRender: 'pause_render',
  saveConfig: 'save_config',
  revealInExplorer: 'reveal_in_explorer',
} as const;

export const TAURI_EVENTS = {
  pipelineEvent: 'pipeline-event',
} as const;
