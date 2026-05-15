import React from 'react';
import { Navigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { MessageCircle as LineIcon, Sparkles as SparklesIcon } from 'lucide-react';
import { useAuth } from '../providers/AuthProvider';

const MASCOT_LOGIN = '/assets/template/mascot-login.png';

const Button = ({ children, variant = 'primary', className = '', ...props }: any) => {
  const base = 'h-[52px] px-8 rounded-full font-bold flex items-center justify-center gap-2 transition-all active:scale-95 duration-200 disabled:cursor-not-allowed disabled:opacity-50';
  const variants: Record<string, string> = {
    primary: 'bg-ai-gradient text-white shadow-[0_4px_12px_rgba(124,58,237,0.3)] hover:opacity-90',
    line: 'bg-[#06C755] text-white hover:opacity-90',
  };

  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

const LoginPage: React.FC = () => {
  const { isReady, isAuthenticated, error, login } = useAuth();

  if (isReady && isAuthenticated) {
    return <Navigate to="/generate" replace />;
  }

  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      <main className="max-w-xl mx-auto pb-12 overflow-x-hidden">
        <div className="flex flex-col items-center justify-center min-h-[85vh] px-6 text-center">
          <motion.div
            initial={{ rotate: -5, scale: 0.9 }}
            animate={{ rotate: -2, scale: 1 }}
            whileHover={{ rotate: 0 }}
            className="bg-white border-2 border-border-light-purple rounded-2xl p-4 shadow-sm flex items-center gap-4 mb-8 w-full max-w-sm"
          >
            <div className="bg-secondary-container rounded-full w-12 h-12 flex items-center justify-center shadow-sm">
              <SparklesIcon className="text-on-secondary-container" />
            </div>
            <p className="font-bold text-on-surface text-left leading-tight">
              Welcome Gift!<br />
              <span className="text-sm font-medium text-on-surface-variant">Available for you</span>
            </p>
          </motion.div>

          <div className="w-full max-w-[280px] aspect-square rounded-[32px] bg-surface-container border-4 border-border-light-purple overflow-hidden shadow-xl mb-10 relative">
            <img src={MASCOT_LOGIN} alt="Mascot" className="w-full h-full object-cover" />
          </div>

          <h2 className="text-3xl font-extrabold text-primary mb-2">Mia-U-Sticker</h2>
          <p className="text-on-surface-variant mb-12">Your Creative Playmate</p>

          <Button variant="line" className="w-full max-w-sm" onClick={login} disabled={!isReady}>
            <LineIcon />
            {isReady ? 'Log in with LINE' : 'Preparing LINE login...'}
          </Button>
          <p className="mt-6 text-xs text-outline">By logging in, you agree to our Terms of Service</p>

          {error ? (
            <div className="mt-6 w-full max-w-sm rounded-2xl border border-error-container bg-error-container p-4 text-sm font-bold text-on-error-container" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
};

export default LoginPage;
