import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { Provider } from 'react-redux';
import { HashRouter } from 'react-router-dom';
import 'core-js/stable';

import configureStore from '@app/store/store';
import App from './app';

// HashRouter expects the route in the URL fragment (e.g. /#/charts), but
// people share / paste path-style URLs (https://beamterminal.0xmx.net/charts).
// nginx serves index.html for any path, so without this redirect the SPA
// would just default to /pairs. Rewrite the path into the hash before mount.
//
// Skip when the path points at a real file (`*.html`): inside the BEAM Wallet
// the page loads at `http://127.0.0.1:<port>/<guid>/app/index.html`, and
// rewriting that into the hash drops the path component, so every relative
// XHR (./amm.wasm, ./dao-accumulator.wasm, favicon.svg) resolves to the
// server root and 404s.
if (typeof window !== 'undefined') {
  const p = window.location.pathname;
  if (p && p !== '/' && !p.endsWith('.html') && !window.location.hash) {
    window.history.replaceState(null, '', `/#${p}${window.location.search}`);
  }
}

if (process.env.NODE_ENV === 'development') {
  import('react-grab').then((m) => m.init({ activationMode: 'toggle', allowActivationInsideInput: false, maxContextLines: 3 }));
}

const { store } = configureStore();

window.global = window;

export default store;

ReactDOM.render(
  <HashRouter>
    <Provider store={store}>
      <App />
    </Provider>
  </HashRouter>,
  document.getElementById('root'),
);
