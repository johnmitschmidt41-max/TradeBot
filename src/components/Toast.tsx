import { useEffect, useState, useCallback, createContext, useContext, ReactNode } from 'react';

// ═══════════════════════════════════════════════════════════════════
// TOAST NOTIFICATION SYSTEM WITH SOUNDS
// ═══════════════════════════════════════════════════════════════════

export type ToastType = 'order_placed' | 'trade_open' | 'trade_win' | 'trade_loss' | 'info' | 'warning' | 'error';

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message: string;
  symbol?: string;
  pips?: number;
  timestamp: number;
}

interface ToastContextType {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'timestamp'>) => void;
  removeToast: (id: string) => void;
  soundEnabled: boolean;
  setSoundEnabled: (enabled: boolean) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

// Sound generation using Web Audio API
const audioContext = typeof window !== 'undefined' ? new (window.AudioContext || (window as any).webkitAudioContext)() : null;

const playSound = (type: ToastType) => {
  if (!audioContext) return;
  
  // Resume audio context if suspended (browser autoplay policy)
  if (audioContext.state === 'suspended') {
    audioContext.resume();
  }
  
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  
  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  
  switch (type) {
    case 'order_placed':
      // Soft ping - two quick notes
      oscillator.frequency.setValueAtTime(880, audioContext.currentTime); // A5
      oscillator.frequency.setValueAtTime(1100, audioContext.currentTime + 0.1); // C#6
      gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
      gainNode.gain.exponentialDecayTo?.(0.01, audioContext.currentTime + 0.2) || 
        gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.2);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
      break;
      
    case 'trade_open':
      // Satisfying "cha-ching" - ascending notes
      oscillator.frequency.setValueAtTime(523, audioContext.currentTime); // C5
      oscillator.frequency.setValueAtTime(659, audioContext.currentTime + 0.08); // E5
      oscillator.frequency.setValueAtTime(784, audioContext.currentTime + 0.16); // G5
      gainNode.gain.setValueAtTime(0.2, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.3);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
      break;
      
    case 'trade_win':
      // Cash register / coin sound - happy ascending melody
      const osc1 = audioContext.createOscillator();
      const osc2 = audioContext.createOscillator();
      const gain1 = audioContext.createGain();
      const gain2 = audioContext.createGain();
      
      osc1.connect(gain1);
      osc2.connect(gain2);
      gain1.connect(audioContext.destination);
      gain2.connect(audioContext.destination);
      
      osc1.frequency.setValueAtTime(784, audioContext.currentTime); // G5
      osc1.frequency.setValueAtTime(988, audioContext.currentTime + 0.1); // B5
      osc1.frequency.setValueAtTime(1175, audioContext.currentTime + 0.2); // D6
      
      osc2.frequency.setValueAtTime(1047, audioContext.currentTime + 0.15); // C6
      osc2.frequency.setValueAtTime(1319, audioContext.currentTime + 0.25); // E6
      
      gain1.gain.setValueAtTime(0.2, audioContext.currentTime);
      gain1.gain.setValueAtTime(0.01, audioContext.currentTime + 0.35);
      gain2.gain.setValueAtTime(0.15, audioContext.currentTime + 0.15);
      gain2.gain.setValueAtTime(0.01, audioContext.currentTime + 0.4);
      
      osc1.start(audioContext.currentTime);
      osc1.stop(audioContext.currentTime + 0.35);
      osc2.start(audioContext.currentTime + 0.15);
      osc2.stop(audioContext.currentTime + 0.4);
      return; // Early return since we handled our own oscillators
      
    case 'trade_loss':
      // Subtle low tone - not annoying
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(220, audioContext.currentTime); // A3
      oscillator.frequency.setValueAtTime(196, audioContext.currentTime + 0.15); // G3
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.3);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.3);
      break;
      
    case 'warning':
      // Alert beep
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
      oscillator.frequency.setValueAtTime(600, audioContext.currentTime + 0.1);
      gainNode.gain.setValueAtTime(0.15, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.15);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.15);
      break;
      
    case 'error':
      // Error buzz
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(150, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.2);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
      break;
      
    default:
      // Info - simple soft ding
      oscillator.frequency.setValueAtTime(700, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
      gainNode.gain.setValueAtTime(0.01, audioContext.currentTime + 0.1);
      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.1);
  }
};

// Toast styling based on type
const getToastStyles = (type: ToastType) => {
  switch (type) {
    case 'order_placed':
      return {
        bg: 'bg-blue-900/90',
        border: 'border-blue-500',
        glow: 'shadow-[0_0_20px_rgba(59,130,246,0.5)]',
        icon: '🎯',
        iconBg: 'bg-blue-500/20',
      };
    case 'trade_open':
      return {
        bg: 'bg-emerald-900/90',
        border: 'border-emerald-500',
        glow: 'shadow-[0_0_20px_rgba(16,185,129,0.5)]',
        icon: '✅',
        iconBg: 'bg-emerald-500/20',
      };
    case 'trade_win':
      return {
        bg: 'bg-green-900/90',
        border: 'border-green-400',
        glow: 'shadow-[0_0_25px_rgba(74,222,128,0.6)] animate-pulse',
        icon: '💰',
        iconBg: 'bg-green-500/20',
      };
    case 'trade_loss':
      return {
        bg: 'bg-red-900/80',
        border: 'border-red-500/70',
        glow: 'shadow-[0_0_15px_rgba(239,68,68,0.3)]',
        icon: '❌',
        iconBg: 'bg-red-500/20',
      };
    case 'warning':
      return {
        bg: 'bg-amber-900/90',
        border: 'border-amber-500',
        glow: 'shadow-[0_0_15px_rgba(245,158,11,0.4)]',
        icon: '⚠️',
        iconBg: 'bg-amber-500/20',
      };
    case 'error':
      return {
        bg: 'bg-red-900/90',
        border: 'border-red-600',
        glow: 'shadow-[0_0_20px_rgba(220,38,38,0.5)]',
        icon: '🚨',
        iconBg: 'bg-red-500/20',
      };
    default:
      return {
        bg: 'bg-gray-800/90',
        border: 'border-gray-600',
        glow: '',
        icon: 'ℹ️',
        iconBg: 'bg-gray-500/20',
      };
  }
};

// Individual Toast Component
const ToastItem = ({ toast, onRemove }: { toast: Toast; onRemove: () => void }) => {
  const [isExiting, setIsExiting] = useState(false);
  const styles = getToastStyles(toast.type);
  
  useEffect(() => {
    // Auto-dismiss after 5 seconds (longer for wins/losses)
    const duration = toast.type === 'trade_win' || toast.type === 'trade_loss' ? 7000 : 5000;
    const timer = setTimeout(() => {
      setIsExiting(true);
      setTimeout(onRemove, 300); // Wait for exit animation
    }, duration);
    
    return () => clearTimeout(timer);
  }, [onRemove, toast.type]);
  
  const handleClose = () => {
    setIsExiting(true);
    setTimeout(onRemove, 300);
  };
  
  return (
    <div
      className={`
        relative overflow-hidden
        ${styles.bg} ${styles.glow}
        border ${styles.border}
        backdrop-blur-md rounded-lg
        p-4 min-w-[320px] max-w-[400px]
        transform transition-all duration-300 ease-out
        ${isExiting ? 'translate-x-full opacity-0' : 'translate-x-0 opacity-100'}
      `}
    >
      {/* Progress bar */}
      <div 
        className={`absolute bottom-0 left-0 h-1 bg-white/30`}
        style={{
          animation: `shrink ${toast.type === 'trade_win' || toast.type === 'trade_loss' ? '7s' : '5s'} linear forwards`
        }}
      />
      
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className={`flex-shrink-0 w-10 h-10 rounded-full ${styles.iconBg} flex items-center justify-center text-xl`}>
          {styles.icon}
        </div>
        
        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-bold text-white text-sm truncate">{toast.title}</h4>
            <button 
              onClick={handleClose}
              className="text-gray-400 hover:text-white transition-colors text-lg leading-none"
            >
              ×
            </button>
          </div>
          <p className="text-gray-300 text-sm mt-1">{toast.message}</p>
          {toast.pips !== undefined && (
            <p className={`text-xs mt-1 font-mono ${toast.pips >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {toast.pips >= 0 ? '+' : ''}{toast.pips} pips
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

// Toast Container Component
export const ToastContainer = () => {
  const context = useContext(ToastContext);
  if (!context) return null;
  
  const { toasts, removeToast, soundEnabled, setSoundEnabled } = context;
  
  return (
    <div className="fixed top-4 right-4 z-[100] flex flex-col gap-3">
      {/* Sound toggle */}
      <button
        onClick={() => setSoundEnabled(!soundEnabled)}
        className={`
          self-end px-3 py-1.5 rounded-lg text-xs font-medium
          transition-all duration-200
          ${soundEnabled 
            ? 'bg-emerald-600/80 text-white border border-emerald-500/50' 
            : 'bg-gray-800/80 text-gray-400 border border-gray-600/50'
          }
        `}
      >
        {soundEnabled ? '🔊 Sound ON' : '🔇 Sound OFF'}
      </button>
      
      {/* Toasts */}
      {toasts.map(toast => (
        <ToastItem 
          key={toast.id} 
          toast={toast} 
          onRemove={() => removeToast(toast.id)} 
        />
      ))}
    </div>
  );
};

// Toast Provider
export const ToastProvider = ({ children }: { children: ReactNode }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [soundEnabled, setSoundEnabled] = useState(true);
  
  const addToast = useCallback((toast: Omit<Toast, 'id' | 'timestamp'>) => {
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    const newToast: Toast = {
      ...toast,
      id,
      timestamp: Date.now(),
    };
    
    setToasts(prev => [...prev, newToast]);
    
    // Play sound
    if (soundEnabled) {
      playSound(toast.type);
    }
  }, [soundEnabled]);
  
  const removeToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);
  
  return (
    <ToastContext.Provider value={{ toasts, addToast, removeToast, soundEnabled, setSoundEnabled }}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
};

// Hook to use toast
export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return context;
};

// CSS for progress bar animation (add to index.css)
export const toastStyles = `
@keyframes shrink {
  from { width: 100%; }
  to { width: 0%; }
}
`;
