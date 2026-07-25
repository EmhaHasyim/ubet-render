import './App.css';
import { render } from 'solid-js/web';
import { addCollection } from 'iconify-icon';
// Bundling lucide icons at build time avoids the runtime CDN fallback that
// fails in production builds because Tauri 2's CSP `connect-src` is locked
// to 'self' and 'tauri:'. Without this, every <Icon icon="lucide:*" /> in
// the bundle shows blank/missing-glyph in production while dev mode works
// thanks to the iconify-icon dev-server middleware.
import lucideIcons from '@iconify-json/lucide/icons.json';
import App from './App';

// Register the lucide collection BEFORE rendering so the first <Icon> in
// the DOM can resolve its body immediately.
// JSON typing from the package is loose; we only need `prefix` and `icons`
// to match the IconifyJSON contract.
addCollection(lucideIcons as unknown as Parameters<typeof addCollection>[0]);

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element #root not found in the DOM.');
render(() => <App />, rootEl);
