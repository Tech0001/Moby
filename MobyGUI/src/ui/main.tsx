import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { ThemeProvider } from './components/ThemeProvider';
import './index.css';

const isElectron = typeof navigator !== 'undefined' && /electron/i.test(navigator.userAgent);
if (typeof document !== 'undefined' && isElectron) {
  document.body.classList.add('is-electron');
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="dark" defaultStyle="cyberpunk">
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
