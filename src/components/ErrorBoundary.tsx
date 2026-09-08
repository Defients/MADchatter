import React, { Component } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';

interface Props {
  children: React.ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  declare props: Props;
  declare state: State;

  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('[ErrorBoundary] Caught error:', error, errorInfo);
    (this as any).setState({ errorInfo });
  }

  handleReload = () => {
    (this as any).setState({ hasError: false, error: null, errorInfo: null });
  };

  handleHardReload = () => {
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-[#0a0a0f] p-4">
          <div className="max-w-md w-full bg-[#121217] border border-red-500/20 rounded-2xl shadow-2xl p-6 flex flex-col items-center text-center gap-4">
            <div className="w-14 h-14 rounded-full bg-red-500/10 border border-red-500/30 flex items-center justify-center">
              <AlertCircle className="w-7 h-7 text-red-400" />
            </div>
            <div className="space-y-1">
              <h2 className="text-lg font-black uppercase tracking-widest text-red-400 font-mono">
                System Crash
              </h2>
              <p className="text-xs text-gray-500 font-mono">
                MADchatter encountered a critical error.
              </p>
            </div>
            <div className="w-full p-3 bg-black/40 border border-white/5 rounded-lg text-left">
              <p className="text-[10px] font-mono text-gray-400 break-words">
                {this.state.error?.message || 'Unknown error'}
              </p>
              {this.state.errorInfo?.componentStack && (
                <pre className="mt-2 text-[9px] font-mono text-gray-600 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </div>
            <div className="flex gap-2 w-full">
              <button
                onClick={this.handleReload}
                className="flex-1 h-10 rounded-lg bg-white/5 border border-white/10 hover:bg-white/10 text-gray-300 font-bold text-xs uppercase tracking-wider transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Try Again
              </button>
              <button
                onClick={this.handleHardReload}
                className="flex-1 h-10 rounded-lg bg-red-500/15 border border-red-500/30 hover:bg-red-500/25 text-red-300 font-bold text-xs uppercase tracking-wider transition-colors flex items-center justify-center gap-2"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reload Page
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
