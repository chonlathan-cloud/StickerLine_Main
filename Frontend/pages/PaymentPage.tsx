import React, { useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { createPayment, getPaymentStatus } from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

// --- Icons ---
const WalletIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
  </svg>
);

const CreditCardIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="20" height="14" x="2" y="5" rx="2" />
    <line x1="2" x2="22" y1="10" y2="10" />
  </svg>
);

const ClockIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10" />
    <polyline points="12 6 12 12 16 14" />
  </svg>
);

const ShieldCheckIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10" />
    <path d="m9 12 2 2 4-4" />
  </svg>
);

const CheckCircleIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
    <polyline points="22 4 12 14.01 9 11.01" />
  </svg>
);

const LockIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
  </svg>
);

const ChevronLeftIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m15 18-6-6 6-6"/>
  </svg>
);

const MoreVerticalIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="1" />
    <circle cx="12" cy="5" r="1" />
    <circle cx="12" cy="19" r="1" />
  </svg>
);

const CloseIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

const BuildingBankIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect width="16" height="16" x="4" y="4" rx="2" />
    <path d="M12 8v8" />
    <path d="M8 8v8" />
    <path d="M16 8v8" />
    <path d="M4 12h16" />
  </svg>
);

const ZapIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const FileTextIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
    <polyline points="14 2 14 8 20 8" />
    <line x1="16" x2="8" y1="13" y2="13" />
    <line x1="16" x2="8" y1="17" y2="17" />
    <line x1="10" x2="8" y1="9" y2="9" />
  </svg>
);

type PackageOption = {
  id: 'pkg_70' | 'pkg_100' | 'pkg_160';
  title: string;
  subtitle: string;
  price: string;
  priceNum: number;
  coins: number;
  highlight?: string;
  gift?: string;
};

type PaymentMethodOption = {
  id: string;
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  iconColorClass: string;
};

type PaymentFlowStatus = 'idle' | 'redirecting' | 'checking' | 'pending' | 'success' | 'failed';

const PACKAGES: PackageOption[] = [
  { 
    id: 'pkg_70', 
    title: '7 เหรียญ', 
    subtitle: 'เหมาะสำหรับลองใช้งานครั้งแรก',
    price: '70 THB', 
    priceNum: 70,
    coins: 7,
    highlight: 'เริ่มต้น'
  },
  { 
    id: 'pkg_100', 
    title: '12 เหรียญ', 
    subtitle: 'แพ็กยอดนิยม คุ้มค่าที่สุด',
    price: '100 THB', 
    priceNum: 100,
    coins: 12, 
    highlight: 'ยอดนิยม',
    gift: 'โบนัส +2 เหรียญ | รวมได้รับ 14 เหรียญ'
  },
  { 
    id: 'pkg_160', 
    title: '20 เหรียญ', 
    subtitle: 'สำหรับแพ็กเกจขนาดใหญ่',
    price: '160 THB', 
    priceNum: 160,
    coins: 20, 
    gift: 'โบนัส +5 เหรียญ | รวมได้รับ 25 เหรียญ'
  },
];

const PAYMENT_METHODS: PaymentMethodOption[] = [
  {
    id: 'promptpay',
    title: 'บัตร / PromptPay',
    subtitle: 'ชำระด้วย QR PromptPay หรือบัตรเครดิต',
    icon: <CreditCardIcon className="w-5 h-5" />,
    iconColorClass: 'text-emerald-600 bg-emerald-50'
  },
  {
    id: 'mobile_banking',
    title: 'Mobile Banking',
    subtitle: 'เลือกธนาคารของคุณ',
    icon: <BuildingBankIcon className="w-5 h-5" />,
    iconColorClass: 'text-blue-600 bg-blue-50'
  },
  {
    id: 'pay_later',
    title: 'ชำระภายหลัง (อัตโนมัติ)',
    subtitle: 'หักอัตโนมัติเมื่อยอดพร้อมชำระ',
    icon: <WalletIcon className="w-5 h-5" />,
    iconColorClass: 'text-purple-600 bg-purple-50'
  },
  {
    id: 'auto_coin',
    title: 'เหรียญอัตโนมัติ',
    subtitle: 'ใช้เหรียญในบัญชีของคุณ',
    icon: <ZapIcon className="w-5 h-5" />,
    iconColorClass: 'text-amber-500 bg-amber-50'
  }
];

const PENDING_PAYMENT_ID_KEY = 'beam_pending_payment_link_id';
const PENDING_CHECKOUT_URL_KEY = 'beam_pending_checkout_url';
const PENDING_PACKAGE_ID_KEY = 'beam_pending_package_id';
const PENDING_EXPIRES_AT_KEY = 'beam_pending_expires_at';
const AUTO_REDIRECT_DELAY_MS = 1800;

const readPendingState = () => {
  try {
    return {
      paymentLinkId: localStorage.getItem(PENDING_PAYMENT_ID_KEY),
      checkoutUrl: localStorage.getItem(PENDING_CHECKOUT_URL_KEY),
      packageId: localStorage.getItem(PENDING_PACKAGE_ID_KEY),
      expiresAt: localStorage.getItem(PENDING_EXPIRES_AT_KEY),
    };
  } catch {
    return { paymentLinkId: null, checkoutUrl: null, packageId: null, expiresAt: null };
  }
};

const persistPendingState = (paymentLinkId: string, checkoutUrl: string, packageId: string, expiresAt?: string | null) => {
  try {
    localStorage.setItem(PENDING_PAYMENT_ID_KEY, paymentLinkId);
    localStorage.setItem(PENDING_CHECKOUT_URL_KEY, checkoutUrl);
    localStorage.setItem(PENDING_PACKAGE_ID_KEY, packageId);
    if (expiresAt) {
      localStorage.setItem(PENDING_EXPIRES_AT_KEY, expiresAt);
    } else {
      localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
    }
  } catch {}
};

const clearPendingState = () => {
  try {
    localStorage.removeItem(PENDING_PAYMENT_ID_KEY);
    localStorage.removeItem(PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PENDING_PACKAGE_ID_KEY);
    localStorage.removeItem(PENDING_EXPIRES_AT_KEY);
  } catch {}
};

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile, coinBalance, isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  // Wizard state
  const [currentStep, setCurrentStep] = useState<1 | 2 | 3>(1);
  const [selectedPackageId, setSelectedPackageId] = useState<PackageOption['id']>('pkg_70');
  const [selectedMethodId, setSelectedMethodId] = useState<string>('promptpay');
  const [acceptedTerms, setAcceptedTerms] = useState<boolean>(true);

  // API State
  const [paymentLinkId, setPaymentLinkId] = useState<string | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [pendingPackageId, setPendingPackageId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [status, setStatus] = useState<PaymentFlowStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const shouldRedirect = isReady && !isAuthenticated;
  const activePackage = PACKAGES.find((pkg) => pkg.id === selectedPackageId)!;
  const activeMethod = PAYMENT_METHODS.find((m) => m.id === selectedMethodId)!;
  const pendingPackage = PACKAGES.find((pkg) => pkg.id === pendingPackageId) ?? null;

  useEffect(() => {
    if (!isReady || !isAuthenticated) return;
    const pendingState = readPendingState();
    setPaymentLinkId(pendingState.paymentLinkId);
    setCheckoutUrl(pendingState.checkoutUrl);
    setPendingPackageId(pendingState.packageId);
    setExpiresAt(pendingState.expiresAt);

    if (pendingState.paymentLinkId) {
      setStatus('pending');
    }
  }, [isAuthenticated, isReady]);

  useEffect(() => {
    if (!paymentLinkId) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('beam_return') !== '1') return;
    void handleCheckStatus(paymentLinkId);
  }, [paymentLinkId]);

  const handleCreatePayment = async () => {
    if (!profile?.userId) return;
    setStatus('redirecting');
    setError(null);

    try {
      const result = await createPayment(profile.userId, activePackage.id);
      persistPendingState(result.payment_link_id, result.checkout_url, activePackage.id, result.expires_at);
      setPaymentLinkId(result.payment_link_id);
      setCheckoutUrl(result.checkout_url);
      setExpiresAt(result.expires_at ?? null);
      window.location.assign(result.checkout_url);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'ไม่สามารถสร้างลิงก์ชำระเงินได้');
    }
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

      if (result.status === 'success') {
        clearPendingState();
        setCheckoutUrl(null);
        setStatus('success');
        await refreshProfile();
        return;
      }

      setStatus(result.status === 'failed' ? 'failed' : 'pending');
      if (result.status === 'failed') {
        setError('รายการชำระเงินนี้ยังไม่สำเร็จหรือหมดอายุแล้ว กรุณาสร้างรายการใหม่อีกครั้ง');
      }
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'ไม่สามารถตรวจสอบสถานะการชำระเงินได้');
    }
  };

  if (shouldRedirect) return <Navigate to="/login" replace />;

  // Render pending or success states (re-using old UI style briefly for pending)
  if (status !== 'idle' && status !== 'redirecting' && status !== 'failed') {
    return (
      <PageLayout isOnline={isOnline}>
        <main className="mx-auto flex w-full max-w-md flex-col gap-6 px-4 pb-12 pt-6">
          <section className="rounded-[28px] border border-emerald-200 bg-emerald-50/80 p-6 shadow-sm">
            <h3 className="text-2xl font-extrabold text-slate-900">
              {status === 'success' ? 'ชำระเงินสำเร็จ' : status === 'checking' ? 'กำลังตรวจสอบ...' : 'มีรายการรอดำเนินการ'}
            </h3>
            <div className="mt-5 flex gap-3">
              {status === 'success' ? (
                 <button onClick={() => navigate('/generate')} className="bg-emerald-600 text-white px-6 py-3 rounded-2xl font-bold">กลับไปสร้างสติกเกอร์</button>
              ) : (
                <>
                  <button onClick={() => handleCheckStatus()} className="bg-emerald-600 text-white px-6 py-3 rounded-2xl font-bold">ตรวจสอบสถานะ</button>
                  <button onClick={() => { clearPendingState(); setStatus('idle'); }} className="border border-slate-300 px-6 py-3 rounded-2xl font-bold">ยกเลิก</button>
                </>
              )}
            </div>
          </section>
        </main>
      </PageLayout>
    );
  }

  // Progress Bar
  const renderProgress = () => {
    return (
      <div className="px-6 pt-6 pb-2 relative">
        <button 
          onClick={() => currentStep > 1 ? setCurrentStep((prev) => (prev - 1) as 1|2|3) : navigate(-1)} 
          className="absolute left-2 top-4 p-2 text-slate-700 hover:bg-slate-100 rounded-full transition-colors z-20"
        >
          <ChevronLeftIcon className="w-6 h-6" />
        </button>
        <div className="relative flex items-center justify-between max-w-[300px] mx-auto">
          {/* Connecting Lines */}
          <div className="absolute left-[15%] right-[50%] h-0.5 bg-emerald-500 top-3 z-0"></div>
          <div className={`absolute left-[50%] right-[15%] h-0.5 top-3 z-0 ${currentStep >= 3 ? 'bg-emerald-500' : 'bg-slate-200'}`}></div>
          
          {/* Step 1 Node */}
          <div className="relative z-10 flex flex-col items-center gap-2 w-16">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${currentStep > 1 ? 'bg-white border-2 border-emerald-500 text-emerald-500' : 'bg-emerald-600 text-white'}`}>
              {currentStep > 1 ? <CheckCircleIcon className="w-4 h-4" /> : '1'}
            </div>
            <span className={`text-[10px] font-bold whitespace-nowrap ${currentStep >= 1 ? 'text-emerald-700' : 'text-slate-400'}`}>เลือกแพ็กเกจ</span>
          </div>

          {/* Step 2 Node */}
          <div className="relative z-10 flex flex-col items-center gap-2 w-16">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${currentStep > 2 ? 'bg-white border-2 border-emerald-500 text-emerald-500' : currentStep === 2 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
              {currentStep > 2 ? <CheckCircleIcon className="w-4 h-4" /> : '2'}
            </div>
            <span className={`text-[10px] font-bold whitespace-nowrap ${currentStep >= 2 ? 'text-emerald-700' : 'text-slate-400'}`}>ช่องทางชำระเงิน</span>
          </div>

          {/* Step 3 Node */}
          <div className="relative z-10 flex flex-col items-center gap-2 w-16">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${currentStep === 3 ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-500'}`}>
              3
            </div>
            <span className={`text-[10px] font-bold whitespace-nowrap ${currentStep === 3 ? 'text-emerald-700' : 'text-slate-400'}`}>ยืนยันการชำระเงิน</span>
          </div>
        </div>
      </div>
    );
  };

  return (
    <div className="min-h-screen bg-white font-sans text-slate-900 pb-24">
      {renderProgress()}

      <main className="px-5 mt-4">
        
        {/* === STEP 1: Select Package === */}
        {currentStep === 1 && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <h2 className="text-xl font-extrabold mb-1">เลือกแพ็กเกจ</h2>
            <p className="text-slate-500 text-sm mb-6">เลือกจำนวนสติกเกอร์ที่ต้องการแพ็กวันนี้</p>
            
            <div className="flex flex-col gap-4">
              {PACKAGES.map((pkg) => {
                const isSelected = selectedPackageId === pkg.id;
                return (
                  <button
                    key={pkg.id}
                    onClick={() => setSelectedPackageId(pkg.id)}
                    className={`relative w-full rounded-[20px] p-5 border-2 text-left transition-all flex justify-between items-center ${
                      isSelected ? 'border-emerald-200 bg-emerald-50/30 shadow-sm' : 'border-slate-100 bg-white hover:border-slate-200'
                    }`}
                  >
                    <div className="flex gap-4">
                      {/* Custom Radio Button */}
                      <div className="mt-1">
                        <div className={`w-5 h-5 rounded-full border-[1.5px] flex items-center justify-center ${isSelected ? 'border-emerald-500' : 'border-slate-300'}`}>
                          {isSelected && <div className="w-2.5 h-2.5 bg-emerald-500 rounded-full" />}
                        </div>
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="text-xl font-extrabold text-slate-900">{pkg.title}</h3>
                        </div>
                        <p className="text-sm font-medium text-slate-500 mt-1">{pkg.subtitle}</p>
                        {pkg.gift && (
                          <div className="mt-3 flex gap-2 text-[11px] font-bold">
                            <span className="text-blue-600 bg-blue-50 px-2 py-0.5 rounded-full">{pkg.gift.split('|')[0].trim()}</span>
                            <span className="text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <ZapIcon className="w-3 h-3" /> {pkg.gift.split('|')[1].trim()}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end">
                      {pkg.highlight && (
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full mb-1 ${isSelected ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                          {pkg.highlight}
                        </span>
                      )}
                      <div className={`font-extrabold text-xl ${isSelected ? 'text-emerald-600' : 'text-slate-900'}`}>{pkg.price}</div>
                      <div className="text-xs text-slate-400 font-medium mt-0.5">{(pkg.priceNum / pkg.coins).toFixed(2)} THB / เหรียญ</div>
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 rounded-2xl bg-slate-50 p-4 flex gap-3 border border-slate-100">
              <ShieldCheckIcon className="w-6 h-6 text-blue-500 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold text-sm text-slate-900">ปลอดภัย มั่นใจได้</p>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">ระบบของเรารองรับการชำระเงินที่ปลอดภัยด้วยการเข้ารหัสข้อมูลทุกขั้นตอน</p>
              </div>
            </div>
          </div>
        )}

        {/* === STEP 2: Select Payment Method === */}
        {currentStep === 2 && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-[10px] font-bold text-emerald-600 uppercase tracking-widest mb-1">Payment</p>
                <h2 className="text-xl font-extrabold text-slate-900">ชำระเงิน</h2>
                <p className="text-sm font-medium text-slate-500 mt-1">ปลอดภัย รวดเร็ว รองรับหลายช่องทาง</p>
              </div>
              <div className="bg-slate-50 px-3 py-1.5 rounded-full flex items-center gap-1.5 border border-slate-100">
                <div className="w-2 h-2 rounded-full bg-emerald-500"></div>
                <span className="text-xs font-bold text-slate-700">Ready</span>
              </div>
            </div>

            {/* Summary Card */}
            <div className="rounded-[20px] border border-slate-100 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5 mb-6 relative overflow-hidden">
              <p className="text-sm font-bold text-slate-500 mb-2">ยอดที่ต้องชำระ</p>
              <div className="flex items-end gap-2">
                <span className="text-4xl font-extrabold text-slate-900">{activePackage.priceNum}</span>
                <span className="text-sm font-bold text-slate-500 mb-1">THB</span>
              </div>
              <p className="text-xs font-medium text-slate-400 mt-2">ชำระผ่าน Beam / UOB</p>
              
              {/* Decorative BG element */}
              <div className="absolute right-4 bottom-4 bg-emerald-50 w-16 h-12 rounded-xl border border-emerald-100 flex items-center justify-center opacity-80">
                 <ShieldCheckIcon className="w-8 h-8 text-emerald-500" />
              </div>
              <div className="absolute right-2 bottom-2 bg-blue-50 w-6 h-6 rounded-full flex items-center justify-center shadow-sm">
                 <LockIcon className="w-3 h-3 text-blue-500" />
              </div>
            </div>

            <h3 className="font-bold text-slate-900 mb-3">ช่องทางการชำระเงิน</h3>
            <div className="flex flex-col gap-3">
              {PAYMENT_METHODS.map((method) => {
                const isSelected = selectedMethodId === method.id;
                return (
                  <button
                    key={method.id}
                    onClick={() => setSelectedMethodId(method.id)}
                    className={`w-full rounded-[16px] p-4 border-2 text-left transition-all flex items-center justify-between ${
                      isSelected ? 'border-emerald-200 bg-emerald-50/20' : 'border-slate-100 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${method.iconColorClass}`}>
                        {method.icon}
                      </div>
                      <div>
                        <p className={`font-bold text-sm ${isSelected ? 'text-slate-900' : 'text-slate-700'}`}>{method.title}</p>
                        <p className="text-xs font-medium text-slate-400 mt-0.5">{method.subtitle}</p>
                      </div>
                    </div>
                    <div>
                       {isSelected ? (
                         <div className="w-6 h-6 rounded-full bg-emerald-500 flex items-center justify-center">
                           <CheckCircleIcon className="w-4 h-4 text-white" />
                         </div>
                       ) : (
                         <div className="w-6 h-6 rounded-full border-2 border-slate-200"></div>
                       )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-6 flex flex-col items-center justify-center gap-1 text-slate-400 text-xs font-medium pb-8">
              <div className="flex items-center gap-1"><ShieldCheckIcon className="w-4 h-4" /> ข้อมูลของคุณปลอดภัย</div>
              <p>เราเข้ารหัสข้อมูลทุกขั้นตอน</p>
            </div>
          </div>
        )}

        {/* === STEP 3: Confirm Payment === */}
        {currentStep === 3 && (
          <div className="animate-in fade-in slide-in-from-right-4 duration-300">
            <h2 className="text-xl font-extrabold mb-1">ยืนยันการชำระเงิน</h2>
            <p className="text-slate-500 text-sm mb-6">ตรวจสอบข้อมูลให้ถูกต้องก่อนยืนยันการชำระเงิน</p>

            <div className="rounded-[20px] border border-slate-100 bg-white shadow-[0_2px_12px_rgba(0,0,0,0.03)] p-5 mb-5">
              <p className="text-sm font-bold text-slate-900 mb-4">สรุปรายการชำระเงิน</p>
              
              <div className="flex items-center justify-between pb-4 border-b border-slate-100 border-dashed">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center border border-emerald-100 text-2xl">✨</div>
                  <div>
                    <p className="font-extrabold text-slate-900">แพ็กเกจ {activePackage.coins} เหรียญ</p>
                    <p className="text-xs font-medium text-slate-500 mt-0.5">{activePackage.subtitle}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-extrabold text-emerald-600 text-lg">{activePackage.priceNum} THB</p>
                  <p className="text-[10px] font-medium text-slate-400">{(activePackage.priceNum / activePackage.coins).toFixed(2)} THB / เหรียญ</p>
                </div>
              </div>

              <div className="pt-4 flex flex-col gap-3 text-sm">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-slate-500 font-medium">
                    <WalletIcon className="w-4 h-4" /> ช่องทางชำระเงิน
                  </div>
                  <div className="font-bold text-slate-900 flex items-center gap-2">
                    {activeMethod.title}
                  </div>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-slate-500 font-medium">
                    <ZapIcon className="w-4 h-4" /> จำนวนเหรียญ
                  </div>
                  <div className="font-bold text-slate-900">{activePackage.coins} เหรียญ</div>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-slate-500 font-medium">
                    <CreditCardIcon className="w-4 h-4" /> ยอดที่ต้องชำระ
                  </div>
                  <div className="font-extrabold text-emerald-600">{activePackage.priceNum} THB</div>
                </div>
              </div>

              <div className="mt-4 pt-4 border-t border-slate-100 flex flex-col gap-2 text-xs">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-slate-400 font-medium">
                    <FileTextIcon className="w-3.5 h-3.5" /> หมายเลขคำสั่งซื้อ
                  </div>
                  <div className="font-medium text-slate-600">INV-{Math.floor(Date.now() / 1000).toString().slice(-6)}-001</div>
                </div>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2 text-slate-400 font-medium">
                    <ClockIcon className="w-3.5 h-3.5" /> วันที่ทำรายการ
                  </div>
                  <div className="font-medium text-slate-600">{new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short'}).format(new Date())}</div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-slate-50 p-4 flex gap-3 border border-slate-100 mb-4">
              <ShieldCheckIcon className="w-5 h-5 text-blue-500 shrink-0" />
              <div>
                <p className="font-bold text-sm text-slate-900">ปลอดภัย มั่นใจได้</p>
                <p className="text-[11px] text-slate-500 mt-1 leading-relaxed">ระบบของเรารองรับการชำระเงินที่ปลอดภัยด้วยการเข้ารหัสข้อมูลทุกขั้นตอน</p>
              </div>
            </div>

            <div className="rounded-2xl bg-emerald-50/50 p-4 flex gap-3 border border-emerald-100 mb-6">
              <div className="w-5 h-5 bg-emerald-500 rounded-full flex items-center justify-center shrink-0">
                <ZapIcon className="w-3 h-3 text-white" />
              </div>
              <div>
                <p className="font-bold text-sm text-emerald-800">เมื่อชำระเงินสำเร็จ</p>
                <ul className="text-[11px] text-emerald-700 mt-1 list-disc pl-3 space-y-0.5">
                  <li>เหรียญจะถูกเพิ่มเข้าบัญชีทันที</li>
                  <li>คุณจะได้รับการแจ้งเตือนผ่าน LINE</li>
                </ul>
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer">
              <div className="mt-0.5">
                 <input 
                   type="checkbox" 
                   checked={acceptedTerms}
                   onChange={(e) => setAcceptedTerms(e.target.checked)}
                   className="w-4 h-4 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" 
                 />
              </div>
              <span className="text-xs font-medium text-slate-600 leading-relaxed">
                ฉันยอมรับเงื่อนไขการให้บริการและนโยบายความเป็นส่วนตัว
              </span>
            </label>

          </div>
        )}

      </main>

      {/* Bottom Sticky Bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-slate-100 p-4 pb-8 md:pb-4 z-30 shadow-[0_-4px_20px_rgba(0,0,0,0.05)]">
        <div className="max-w-md mx-auto flex items-center justify-between gap-4">
          
          {currentStep === 1 && (
            <>
              <div>
                <p className="text-xs font-bold text-slate-500">ยอดที่ต้องชำระ</p>
                <p className="text-2xl font-extrabold text-emerald-600">{activePackage.priceNum} <span className="text-sm">THB</span></p>
              </div>
              <button 
                onClick={() => setCurrentStep(2)}
                className="bg-emerald-600 text-white flex-1 py-3.5 rounded-2xl font-bold flex flex-col items-center justify-center leading-none transition-transform active:scale-[0.98]"
              >
                <span>ต่อไป</span>
                <span className="text-[10px] font-medium text-emerald-200 mt-1">ไปยังขั้นตอนสรุปและชำระเงิน</span>
              </button>
            </>
          )}

          {currentStep === 2 && (
            <button 
              onClick={() => setCurrentStep(3)}
              className="bg-emerald-600 text-white w-full py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 transition-transform active:scale-[0.98]"
            >
              <LockIcon className="w-4 h-4" /> ดำเนินการชำระเงิน {activePackage.priceNum} THB
            </button>
          )}

          {currentStep === 3 && (
            <div className="w-full flex flex-col items-center gap-2">
              {error && <p className="text-xs text-rose-500 font-bold">{error}</p>}
              <button 
                onClick={handleCreatePayment}
                disabled={!acceptedTerms || status === 'redirecting'}
                className="bg-emerald-600 text-white w-full py-3.5 rounded-2xl font-bold flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
              >
                {status === 'redirecting' ? (
                  <span className="animate-pulse">กำลังเปิดหน้าชำระเงิน...</span>
                ) : (
                  <><LockIcon className="w-4 h-4" /> ยืนยันการชำระเงิน {activePackage.priceNum} THB</>
                )}
              </button>
            </div>
          )}

        </div>
      </div>

    </div>
  );
};

export default PaymentPage;
