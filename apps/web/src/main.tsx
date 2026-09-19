import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/global.css';

const container = document.getElementById('root');
if (container === null) throw new Error('index.html is missing <div id="root">.');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
