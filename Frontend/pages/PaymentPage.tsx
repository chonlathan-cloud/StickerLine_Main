import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import {
  clearPendingPayment,
  getPaymentStatus,
  PaymentProductId,
  PENDING_CHECKOUT_URL_KEY,
  PENDING_EXPIRES_AT_KEY,
  PENDING_PAYMENT_ID_KEY,
  PENDING_PRODUCT_ID_KEY,
} from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

type PaymentFlowStatus = 'idle' | 'checking' | 'pending' | 'success' | 'failed';

type PendingPaymentState = {
  paymentLinkId: string | null;
  checkoutUrl: string | null;
  productId: PaymentProductId | null;
  expiresAt: string | null;
};

const PRODUCT_COPY: Record<PaymentProductId, { title: string; description: string; success: string }> = {
  final_pack_199: {
    title: 'Final pack 199 THB',
    description: 'ปลดล็อกการบันทึก final 16 stickers สำหรับรอบนี้',
    success: 'ปลดล็อก final pack แล้ว กลับไปบันทึกรูปต่อได้เลย',
  },
  extra_pack_99: {
    title: 'Extra pack 99 THB',
    description: 'ปลดล็อกการ export Extra Vault ที่เลือกไว้ สูงสุด 16 รูป',
    success: 'ปลดล็อก extra pack แล้ว กลับไปดาวน์โหลดรูปที่เลือกไว้ได้เลย',
  },
};

const AUTO_REDIRECT_DELAY_MS = 1500;

const readPendingPayment = (): PendingPaymentState => {
  try {
    const productId = localStorage.getItem(PENDING_PRODUCT_ID_KEY) as PaymentProductId | null;
    return {
      paymentLinkId: localStorage.getItem(PENDING_PAYMENT_ID_KEY),
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
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [productId, setProductId] = useState<PaymentProductId | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [showReference, setShowReference] = useState(false);

  const shouldRedirect = isReady && !isAuthenticated;
  const productCopy = productId ? PRODUCT_COPY[productId] : null;
  const expiryLabel = useMemo(() => formatDateTime(expiresAt), [expiresAt]);

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
        setError('รายการชำระเงินนี้ยังไม่สำเร็จหรือหมดอายุแล้ว กรุณากลับไปเริ่มจากหน้าสร้างสติกเกอร์อีกครั้ง');
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'ไม่สามารถตรวจสอบสถานะการชำระเงินได้');
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
    const timeout = window.setTimeout(() => navigate('/generate'), AUTO_REDIRECT_DELAY_MS);
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
    setShowReference(false);
  };

  if (shouldRedirect) {
    return <Navigate to="/login" replace />;
  }

  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 px-4 pb-12 pt-6">
        <section className="rounded-[28px] border border-slate-200 bg-white p-6 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-600">Secure Payment</p>
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">
            {productCopy?.title ?? 'Payment status'}
          </h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {productCopy?.description ?? 'รายการชำระเงินจะเริ่มจากปุ่ม Save หรือ Extra Vault ในหน้าสร้างสติกเกอร์'}
          </p>
        </section>

        <section className="rounded-[28px] border border-emerald-200 bg-emerald-50/80 p-6 shadow-sm">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-emerald-700">Payment Status</p>
          <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-slate-900">
            {status === 'success'
              ? 'ชำระเงินสำเร็จ'
              : status === 'failed'
                ? 'รายการชำระเงินมีปัญหา'
                : status === 'checking'
                  ? 'กำลังตรวจสอบสถานะ'
                  : paymentLinkId
                    ? 'มีรายการชำระเงินรอดำเนินการ'
                    : 'ยังไม่มีรายการชำระเงิน'}
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            {status === 'success'
              ? productCopy?.success ?? 'ชำระเงินสำเร็จแล้ว กำลังพากลับไปหน้าสร้างสติกเกอร์'
              : paymentLinkId
                ? 'ถ้าชำระเงินแล้ว กดตรวจสอบสถานะอีกครั้ง ระบบจะเช็กกับ Beam โดยตรง'
                : 'กลับไปที่หน้าสร้างสติกเกอร์ แล้วกด Save หรือเลือก Extra Vault เพื่อเริ่มชำระเงิน'}
          </p>

          {expiryLabel ? (
            <p className="mt-3 text-xs font-medium text-slate-500">หมดอายุ: {expiryLabel}</p>
          ) : null}

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {status !== 'success' && paymentLinkId ? (
              <button
                type="button"
                onClick={() => handleCheckStatus()}
                disabled={status === 'checking'}
                className="focus-ring min-h-12 rounded-2xl bg-emerald-600 px-6 py-3 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {status === 'checking' ? 'กำลังตรวจสอบ...' : 'ฉันชำระเงินแล้ว'}
              </button>
            ) : null}

            {checkoutUrl && status !== 'success' ? (
              <button
                type="button"
                onClick={handleResumeCheckout}
                className="focus-ring min-h-12 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 transition hover:border-emerald-300"
              >
                กลับไปหน้าชำระเงิน
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => navigate('/generate')}
              className="focus-ring min-h-12 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 transition hover:border-sky-300"
            >
              กลับไปหน้าสร้างสติกเกอร์
            </button>

            {(status === 'failed' || status === 'pending') && paymentLinkId ? (
              <button
                type="button"
                onClick={handleResetPending}
                className="focus-ring min-h-12 rounded-2xl border border-slate-200 bg-white px-6 py-3 text-sm font-bold text-slate-700 transition hover:border-rose-300"
              >
                ล้างรายการนี้
              </button>
            ) : null}
          </div>

          {paymentLinkId ? (
            <div className="mt-4 border-t border-emerald-200 pt-4">
              <button
                type="button"
                onClick={() => setShowReference((prev) => !prev)}
                className="text-sm font-bold text-slate-700 underline decoration-slate-300 underline-offset-4"
              >
                {showReference ? 'ซ่อนข้อมูลอ้างอิงรายการ' : 'ดูข้อมูลอ้างอิงรายการ'}
              </button>
              {showReference ? (
                <div className="mt-3 rounded-2xl border border-emerald-200 bg-white/90 p-4 text-xs text-slate-500">
                  <p>Payment Link ID</p>
                  <p className="mt-1 break-all font-semibold text-slate-700">{paymentLinkId}</p>
                  {productId ? <p className="mt-3">Product: {productId}</p> : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>

        {error ? (
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800 shadow-sm" role="alert">
            {error}
          </div>
        ) : null}
      </main>
    </PageLayout>
  );
};

export default PaymentPage;
