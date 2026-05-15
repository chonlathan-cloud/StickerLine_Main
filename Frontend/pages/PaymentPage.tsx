import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  ArrowLeft as BackIcon,
  CheckCircle2 as CheckIcon,
  CreditCard as PaymentsIcon,
  Download as DownloadIcon,
  Heart as HeartIcon,
  Monitor as HighQualityIcon,
  RefreshCw as RefreshIcon,
  ShoppingCart as PayIcon,
  Star as StarIcon,
  Unlock as UnlockIcon,
  X as CloseIcon,
} from 'lucide-react';
import {
  PaymentProductId,
  PENDING_CHECKOUT_URL_KEY,
  PENDING_EXPIRES_AT_KEY,
  PENDING_PAYMENT_ID_KEY,
  PENDING_PRODUCT_ID_KEY,
  clearPendingPayment,
  getPaymentStatus,
} from '../api/client';
import { useAuth } from '../providers/AuthProvider';

type PaymentFlowStatus = 'idle' | 'checking' | 'pending' | 'success' | 'failed';

type PendingPaymentState = {
  paymentLinkId: string | null;
  checkoutUrl: string | null;
  productId: PaymentProductId | null;
  expiresAt: string | null;
};

const PRODUCT_COPY: Record<PaymentProductId, { title: string; price: string; description: string; success: string }> = {
  final_pack_199: {
    title: 'Final Pack',
    price: '199 THB',
    description: 'Unlock saving the final 16 stickers for this round.',
    success: 'Payment successful. Taking you to Save to Photos...',
  },
  extra_pack_99: {
    title: 'Extra Vault',
    price: '99 THB',
    description: 'Unlock export for selected Extra Vault stickers.',
    success: 'Payment successful. Taking you to Extra Vault...',
  },
};

const STICKER_PACK = '/assets/template/sticker-pack.png';
const AUTO_REDIRECT_DELAY_MS = 500;

const Button = ({ children, variant = 'primary', className = '', ...props }: any) => {
  const base = 'h-[52px] px-8 rounded-full font-bold flex items-center justify-center gap-2 transition-all active:scale-95 duration-200 disabled:cursor-not-allowed disabled:opacity-50';
  const variants: Record<string, string> = {
    primary: 'bg-ai-gradient text-white shadow-[0_4px_12px_rgba(124,58,237,0.3)] hover:opacity-90',
    secondary: 'bg-surface-container text-on-surface border-2 border-border-light-purple hover:bg-surface-container-high',
    ghost: 'text-on-surface-variant hover:bg-surface-container',
  };

  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

const readPaymentIdFromUrl = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('payment_link_id')
    || params.get('paymentLinkId')
    || params.get('charge_id')
    || params.get('chargeId')
    || params.get('sourceId')
    || params.get('id');
};

const readPendingPayment = (): PendingPaymentState => {
  try {
    const productId = localStorage.getItem(PENDING_PRODUCT_ID_KEY) as PaymentProductId | null;
    return {
      paymentLinkId: readPaymentIdFromUrl() || localStorage.getItem(PENDING_PAYMENT_ID_KEY),
      checkoutUrl: localStorage.getItem(PENDING_CHECKOUT_URL_KEY),
      productId: productId && PRODUCT_COPY[productId] ? productId : null,
      expiresAt: localStorage.getItem(PENDING_EXPIRES_AT_KEY),
    };
  } catch {
    return { paymentLinkId: null, checkoutUrl: null, productId: null, expiresAt: null };
  }
};

const formatDateTime = (value?: string | null) => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const PaymentPage: React.FC = () => {
  const { isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [productId, setProductId] = useState<PaymentProductId | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const shouldRedirect = isReady && !isAuthenticated;
  const productCopy = productId ? PRODUCT_COPY[productId] : null;
  const expiryLabel = useMemo(() => formatDateTime(expiresAt), [expiresAt]);
  const isExtra = productId === 'extra_pack_99';
  const isSuccess = status === 'success';
  const continueLabel = isExtra ? 'Go to Extra Vault' : 'Go to Save to Photos';

  const hydratePendingPayment = () => {
    const pending = readPendingPayment();
    setPaymentLinkId(pending.paymentLinkId);
    setCheckoutUrl(pending.checkoutUrl);
    setProductId(pending.productId);
    setExpiresAt(pending.expiresAt);
    setStatus(pending.paymentLinkId ? 'pending' : 'idle');
  };

  const handleCheckStatus = async (targetPaymentLinkId?: string) => {
    const resolvedPaymentLinkId = targetPaymentLinkId || paymentLinkId;
    if (!resolvedPaymentLinkId) return;

    setStatus('checking');
    setError(null);

    try {
      const result = await getPaymentStatus(resolvedPaymentLinkId);
      setCheckoutUrl(result.checkout_url || null);
      setExpiresAt(result.expires_at ?? null);
      if (result.product_id && PRODUCT_COPY[result.product_id]) {
        setProductId(result.product_id);
      }

      if (result.status === 'success') {
        clearPendingPayment();
        setCheckoutUrl(null);
        setStatus('success');
        await refreshProfile();
        return;
      }

      setStatus(result.status === 'failed' ? 'failed' : 'pending');
      if (result.status === 'failed') {
        setError('This Beam payment is not successful or has expired. Please return to Generate and start again.');
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'Could not verify Beam payment status.');
    }
  };

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;
    hydratePendingPayment();
  }, [isAuthenticated, isReady]);

  useEffect(() => {
    if (!paymentLinkId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('beam_return') !== '1') return;
    void handleCheckStatus(paymentLinkId);
  }, [paymentLinkId]);

  useEffect(() => {
    if (status !== 'success') return;
    const timeout = window.setTimeout(() => navigate('/generate', { replace: true }), AUTO_REDIRECT_DELAY_MS);
    return () => window.clearTimeout(timeout);
  }, [navigate, status]);

  const handleResumeCheckout = () => {
    if (!checkoutUrl) return;
    window.location.assign(checkoutUrl);
  };

  const handleResetPending = () => {
    clearPendingPayment();
    setPaymentLinkId(null);
    setCheckoutUrl(null);
    setProductId(null);
    setExpiresAt(null);
    setStatus('idle');
    setError(null);
  };

  if (shouldRedirect) {
    return <Navigate to="/login" replace />;
  }

  const features = isExtra
    ? [
        { icon: <HeartIcon />, text: 'Unlock selected hidden gems' },
        { icon: <HighQualityIcon />, text: 'High-resolution extra export' },
        { icon: <UnlockIcon />, text: 'Separate from Final Pack' },
      ]
    : [
        { icon: <HeartIcon />, text: 'Save all 16 unique stickers' },
        { icon: <HighQualityIcon />, text: 'High-resolution export' },
        { icon: <UnlockIcon />, text: 'Continue to Save to Photos' },
      ];

  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      <main className="max-w-xl mx-auto pb-12 overflow-x-hidden">
        <div className="flex flex-col gap-8 p-6 max-w-md mx-auto">
          <div className="flex items-center justify-between">
            <Button variant="ghost" className="p-0 h-10 w-10" onClick={() => navigate('/generate')}><BackIcon /></Button>
            <h2 className="text-xl font-extrabold text-primary">{isSuccess ? 'Payment Success' : 'Unlock Pack'}</h2>
            <Button variant="ghost" className="p-0 h-10 w-10" onClick={() => navigate('/generate')}><CloseIcon /></Button>
          </div>

          <div className="flex flex-col items-center text-center">
            <div className="w-48 h-48 rounded-[40px] bg-white border-4 border-border-light-purple shadow-xl mb-6 relative overflow-hidden flex items-center justify-center p-4">
              <img src={STICKER_PACK} alt="Pack" className="w-full h-full object-contain" />
              <div className="absolute -top-2 -right-2 bg-secondary-container p-2 rounded-full shadow-lg rotate-12">
                {status === 'success' ? <CheckIcon className="text-on-secondary-container" /> : <StarIcon className="text-on-secondary-container" />}
              </div>
            </div>
            <h3 className="text-2xl font-extrabold mb-2">{isSuccess ? 'Payment Success!' : productCopy?.title ?? 'Payment Status'}</h3>
            <div className="px-8 py-2 bg-surface-container rounded-full border-2 border-border-light-purple">
              <span className="text-3xl font-black text-ai-gradient italic">{productCopy?.price ?? 'Beam'}</span>
            </div>
            <p className="mt-4 text-sm text-on-surface-variant">
              {isSuccess
                ? productCopy?.success ?? 'Payment successful. Continue to your stickers.'
                : productCopy?.description ?? 'Start payment from Generate or Extra Vault.'}
            </p>
            {expiryLabel ? <p className="mt-2 text-xs text-outline">Expires: {expiryLabel}</p> : null}
          </div>

          <div className="bg-surface-container rounded-[32px] p-6 border-2 border-border-light-purple space-y-4">
            {features.map((feature, index) => (
              <div key={index} className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
                  {feature.icon}
                </div>
                <p className="font-bold text-on-surface">{feature.text}</p>
              </div>
            ))}
          </div>

          {error ? (
            <div className="rounded-2xl border border-error-container bg-error-container p-4 text-sm font-bold text-on-error-container" role="alert">
              {error}
            </div>
          ) : null}

          <div className="mt-auto flex flex-col gap-3">
            {paymentLinkId && status !== 'success' ? (
              <Button className="w-full py-6 text-xl" onClick={() => handleCheckStatus()} disabled={status === 'checking'}>
                {status === 'checking' ? <RefreshIcon className="animate-spin" /> : <PaymentsIcon />}
                {status === 'checking' ? 'Checking Beam...' : 'I Paid with Beam'}
              </Button>
            ) : null}

            {checkoutUrl && status !== 'success' ? (
              <Button variant="secondary" className="w-full" onClick={handleResumeCheckout}>
                <PayIcon />
                Back to Beam Checkout
              </Button>
            ) : null}

            <Button variant={isSuccess ? 'primary' : 'secondary'} className="w-full" onClick={() => navigate('/generate')}>
              {isSuccess ? <DownloadIcon /> : <BackIcon />}
              {isSuccess ? continueLabel : 'Back to Generate'}
            </Button>

            {(status === 'failed' || status === 'pending') && paymentLinkId ? (
              <button type="button" onClick={handleResetPending} className="text-on-surface-variant font-bold text-sm">
                Clear this payment reference
              </button>
            ) : null}
            <p className="text-center text-xs text-on-surface-variant mt-1 opacity-70">Secure payment powered by Beam.</p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default PaymentPage;
