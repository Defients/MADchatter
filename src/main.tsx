import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { TooltipProvider } from './components/ui/tooltip';
import { Toaster } from './components/ui/sonner';
import { ErrorBoundary } from './components/ErrorBoundary';
import { useAppStore } from './store';
import { useIsMobile } from './hooks/useMediaQuery';
import { MotionConfig } from 'motion/react';

function AppToaster() {
  const light = useAppStore((s) => s.lightThemeActive);
  const isMobile = useIsMobile();

  // Desktop: bottom-center keeps toasts out of the way of centered CORE
  // content; the offset lifts them above the fixed StatusBar/footer.
  //
  // Mobile CORE: the CORE header is the persistent 48px bar (+ safe-area
  // inset) at the top of the viewport and the bottom of the screen is already
  // spent on the telemetry strip + tab bar. Toasts therefore dock at the TOP,
  // immediately beneath the header — offset 40px deliberately tucks the toast
  // container ~8px into the header's lower edge so the stack starts tighter,
  // while the header's own controls stay above it and fully usable. env()
  // keeps it correct under notches/dynamic islands, and because Sonner renders
  // in a fixed-position portal the stack never pushes the CORE layout down.
  const position = isMobile ? 'top-center' : 'bottom-center';
  const offset = isMobile
    ? { top: 'calc(env(safe-area-inset-top, 0px) + 40px)' }
    : { bottom: '56px' };

  return (
    <Toaster
      theme={light ? 'light' : 'dark'}
      position={position}
      offset={offset}
      mobileOffset={{ top: 'calc(env(safe-area-inset-top, 0px) + 40px)' }}
      closeButton={isMobile}
      gap={8}
    />
  );
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
