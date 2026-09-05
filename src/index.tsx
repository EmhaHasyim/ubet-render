import './App.css';
import { render } from 'solid-js/web';
import App from './App';
import { applyTheme, loadTheme } from './core/theme';

// Apply the persisted (or OS-derived) theme synchronously BEFORE the first
// render. Titlebar also applies it on mount, but that runs after the first
// paint and would flash the default theme on every launch.
applyTheme(loadTheme());

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in the DOM.');
render(() => <App />, rootEl);
