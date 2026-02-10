import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { TripProvider } from './store';
import { ErrorBoundary, ToastProvider } from './components';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <TripProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </TripProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>
);
