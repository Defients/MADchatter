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
  // bottom-center keeps toasts out of the way of centered Core content;
  // the offset lifts them above the fixed StatusBar/footer so they never clip it.
  return <Toaster theme={light ? 'light' : 'dark'} position="bottom-center" offset="56px" />;
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
