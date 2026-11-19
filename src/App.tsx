import { createSignal, onSettled } from 'solid-js';
import { Errored } from '@solidjs/web';
import { Dashboard } from './components/layout/Dashboard';
import { PipelineBridge } from './context/PipelineBridge';
import { FatalScreen } from './components/ui/FatalScreen';
import { ShortcutsDialog } from './components/ui/ShortcutsDialog';
import { useAppShortcuts, type AppTabId } from './hooks/useAppShortcuts';
import { ToastViewport } from './components/ui/Toast';
import { checkForUpdates } from './core/updater';

export default function App() {
  const [activeTab, setActiveTab] = createSignal<AppTabId>('renderer');
  const { isShortcutsOpen, closeShortcuts } = useAppShortcuts(setActiveTab);

  // Check for a new release on startup (production builds only).
  onSettled(() => {
    void checkForUpdates();
  });

  return (
    <Errored
      fallback={(err, reset) => <FatalScreen error={err()} reset={reset} />}
    >
      <PipelineBridge>
        {(pipeline) => (
          <Dashboard
            pipeline={pipeline}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
          />
        )}
      </PipelineBridge>
      {/* Global shortcuts dialog — mounted as a top-level component so
          the F1 hotkey works regardless of which sub-tree has focus. */}
      <ShortcutsDialog isOpen={isShortcutsOpen()} onClose={closeShortcuts} />
      {/* Global toast viewport — renders via portal so it overlays every tab. */}
      <ToastViewport />
    </Errored>
  );
}
