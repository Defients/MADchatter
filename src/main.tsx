import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAppStore } from './store';
import { MotionConfig } from 'motion/react';

function AppToaster() {
  const light = useAppStore((s) => s.lightThemeActive);
  return <Toaster theme={light ? 'light' : 'dark'} position="bottom-center" />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <MotionConfig reducedMotion="user">
      <TooltipProvider>
        <App />
        <AppToaster />
      </TooltipProvider>
      </MotionConfig>
    </ErrorBoundary>
  </StrictMode>,
);
