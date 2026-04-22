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

const ZapIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

const WalletOutlineIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
    <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
    <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
  </svg>
);

const PlusCircleIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <circle cx="12" cy="12" r="10"/>
    <path d="M8 12h8"/>
    <path d="M12 8v8"/>
  </svg>
);

const ChevronRightIcon = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="m9 18 6-6-6-6"/>
  </svg>
);

type PackageOption = {
  id: 'pkg_70' | 'pkg_100';
  title: string;
  subtitle: string;
  price: string;
  coins: number;
  highlight?: string;
  paymentMethods: string;
};

const PACKAGES: PackageOption[] = [
  { 
    id: 'pkg_70', 
    title: 'แพ็กเริ่มต้น', 
    subtitle: 'เหมาะสำหรับลองใช้งานครั้งแรก',
    price: '70 THB', 
    coins: 7,
    paymentMethods: 'ชำระผ่าน Beam / UOB'
  },
  { 
    id: 'pkg_100', 
    title: 'แพ็กคุ้มค่า', 
    subtitle: 'แพ็กยอดนิยม ได้เหรียญคุ้มกว่า',
    price: '100 THB', 
    coins: 12, 
    highlight: 'โบนัส +2 เหรียญ',
    paymentMethods: 'ชำระผ่าน Beam / UOB'
  },
];

const PaymentPage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile, coinBalance, isAuthenticated, isReady, refreshProfile } = useAuth();
  const navigate = useNavigate();

  const [selectedPackage, setSelectedPackage] = useState<PackageOption | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [chargeId, setChargeId] = useState<string | null>(null);
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'failed'>('idle');
  const [error, setError] = useState<string | null>(null);

  const shouldRedirect = isReady && !isAuthenticated;

  useEffect(() => {
    if (!chargeId || status !== 'pending') return;

    const interval = window.setInterval(async () => {
      try {
        const result = await getPaymentStatus(chargeId);
        if (result.status === 'success') {
          setStatus('success');
          await refreshProfile();
        }
      } catch (err: any) {
        setError(err?.response?.data?.detail || err?.message || 'Failed to check payment status.');
      }
    }, 5000);

    return () => window.clearInterval(interval);
  }, [chargeId, status, refreshProfile]);

  const handleSelectPackage = async (pkg: PackageOption) => {
    if (!profile?.userId) return;
    setSelectedPackage(pkg);
    setStatus('pending');
    setError(null);

    try {
      const result = await createPayment(profile.userId, pkg.id);
      setChargeId(result.charge_id);
      setQrUrl(result.qr_image_url);
    } catch (err: any) {
      setStatus('failed');
      setError(err?.response?.data?.detail || err?.message || 'Failed to create payment.');
    }
  };

  const handleManualCheck = async () => {
    if (!chargeId) return;
    try {
      const result = await getPaymentStatus(chargeId);
      if (result.status === 'success') {
        setStatus('success');
        await refreshProfile();
      }
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Failed to check payment status.');
    }
  };

  const handleCloseModal = () => {
    setSelectedPackage(null);
    setQrUrl(null);
    setChargeId(null);
    setStatus('idle');
    setError(null);
  };

  const handleSuccessReturn = () => {
    navigate('/generate');
  };

  if (shouldRedirect) {
    return <Navigate to="/login" replace />;
  }

  const modalTitle = useMemo(() => {
    if (status === 'success') return 'ชำระเงินสำเร็จ';
    if (status === 'failed') return 'ชำระเงินล้มเหลว';
    return 'สแกนเพื่อชำระเงิน';
  }, [status]);

  const currentCoins = coinBalance || 0;

  return (
    <PageLayout isOnline={isOnline}>
      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-12 pt-6">
        
        {/* Top Header Card */}
        <section className="rounded-[28px] bg-white p-6 md:p-8 shadow-sm border border-slate-200 flex flex-col gap-6 relative">
          
          <div className="relative z-10">
            <div className="flex items-center gap-2 mb-3 text-slate-500">
              <PlusCircleIcon className="w-5 h-5" />
              <p className="text-sm font-bold">เติมเหรียญ</p>
            </div>
            <h2 className="text-2xl md:text-3xl font-extrabold mb-3 tracking-tight text-slate-900">เติมเหรียญเพื่อสร้างสติ๊กเกอร์</h2>
            <p className="text-slate-500 text-sm md:text-base font-medium max-w-xl">
              ระบบจะพาไปหน้าชำระเงินที่ปลอดภัย และพากลับอัตโนมัติ
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 relative z-10">
            {/* Card 1 */}
            <div className="bg-slate-50 rounded-2xl p-5 border border-slate-100 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-blue-100 text-blue-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <WalletIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">เหรียญของคุณ</p>
              </div>
              <p className="text-3xl font-extrabold text-slate-900">{currentCoins} <span className="text-sm font-semibold text-slate-500">เหรียญ</span></p>
            </div>
            
            {/* Card 2 */}
            <div className="bg-emerald-50/50 rounded-2xl p-5 border border-emerald-50 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-emerald-100 text-emerald-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <CreditCardIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">ช่องทางชำระเงิน</p>
              </div>
              <p className="text-sm font-bold leading-relaxed text-slate-600">บัตร / PromptPay,<br />Mobile Banking</p>
            </div>

            {/* Card 3 */}
            <div className="bg-purple-50/50 rounded-2xl p-5 border border-purple-50 flex flex-col justify-between">
              <div className="flex items-center gap-3 mb-4">
                <div className="bg-purple-100 text-purple-600 rounded-full w-9 h-9 flex items-center justify-center">
                  <ClockIcon className="w-4 h-4 md:w-5 md:h-5" />
                </div>
                <p className="text-slate-700 text-sm font-bold">เหรียญเข้าเมื่อ</p>
              </div>
              <p className="text-sm font-bold leading-relaxed text-slate-600">ชำระเงินสำเร็จ</p>
            </div>
          </div>

          <hr className="border-slate-100 my-2" />

          {/* Badges */}
          <div className="flex flex-col sm:flex-row gap-4 sm:gap-0 justify-between text-xs md:text-sm font-bold text-slate-600">
            <div className="flex items-center gap-2 flex-1 justify-center sm:justify-start">
              <ShieldCheckIcon className="w-5 h-5 text-slate-500" /> ชำระเงินปลอดภัย
            </div>
            <div className="hidden sm:block w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-2 flex-1 justify-center">
              <WalletOutlineIcon className="w-5 h-5 text-slate-500 shrink-0" /> <span className="text-center sm:text-left">รองรับ PromptPay<br className="hidden md:block" />และ Mobile Banking</span>
            </div>
            <div className="hidden sm:block w-px h-8 bg-slate-200"></div>
            <div className="flex items-center gap-2 flex-1 justify-center sm:justify-end">
              <ZapIcon className="w-5 h-5 text-slate-500" /> เหรียญเข้าอัตโนมัติทันที
            </div>
          </div>
        </section>

        {/* Packages List */}
        <section className="flex flex-col gap-4">
          {PACKAGES.map((pkg) => (
            <div 
              key={pkg.id} 
              onClick={() => handleSelectPackage(pkg)}
              className="relative overflow-hidden rounded-[24px] bg-white p-6 shadow-sm border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center cursor-pointer hover:shadow-md hover:border-slate-300 transition-all group"
            >
              {/* Left colored line */}
              <div className={`absolute top-0 left-0 bottom-0 w-1.5 ${pkg.id === 'pkg_70' ? 'bg-blue-500' : 'bg-emerald-500'}`} />

              <div className="flex flex-col gap-1.5 w-full md:w-auto pl-3">
                <div className="flex items-center gap-3">
                  <h3 className="font-extrabold text-xl text-slate-900 group-hover:text-blue-600 transition-colors">{pkg.title}</h3>
                  {pkg.highlight && (
                    <span className="bg-emerald-50 text-emerald-600 text-xs px-2.5 py-1 rounded-full font-bold border border-emerald-100">
                      {pkg.highlight}
                    </span>
                  )}
                </div>
                <p className="text-slate-500 text-sm font-medium">{pkg.subtitle}</p>
                <div className="mt-3 flex items-baseline gap-1.5">
                  <span className="text-3xl font-extrabold text-blue-500">{pkg.coins}</span>
                  <span className="text-slate-500 text-sm font-bold">เหรียญ</span>
                </div>
                <p className="text-slate-400 text-xs font-medium">เติมแล้วจะมีประมาณ {currentCoins + pkg.coins} เหรียญ</p>
              </div>

              <div className="mt-6 md:mt-0 flex items-center justify-between w-full md:w-auto border-t md:border-t-0 border-slate-100 pt-4 md:pt-0 gap-6">
                <div className="flex flex-col items-start md:items-end">
                  <div className="font-extrabold text-2xl text-slate-900">{pkg.price}</div>
                  <div className="text-slate-400 text-xs mt-1 font-medium">{pkg.paymentMethods}</div>
                </div>
                <div className="w-10 h-10 rounded-full border border-slate-200 flex items-center justify-center text-slate-400 group-hover:border-blue-500 group-hover:text-blue-500 transition-colors bg-white shadow-sm">
                  <ChevronRightIcon className="w-5 h-5" />
                </div>
              </div>
            </div>
          ))}
        </section>

        {error && (
          <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm font-medium text-amber-800 shadow-sm" role="alert">
            {error}
          </div>
        )}
      </main>

      {/* Modal */}
      {selectedPackage && (
        <div className="fixed inset-0 z-50 flex min-h-dvh flex-col bg-slate-950/80 px-4 py-8 backdrop-blur-sm transition-all">
          <div className="mx-auto flex w-full max-w-md flex-1 flex-col rounded-[2.5rem] bg-white p-6 shadow-2xl animate-in fade-in zoom-in duration-200">
            <div className="flex items-center justify-between">
              <h3 className="text-xl font-bold text-slate-900">{modalTitle}</h3>
              <button
                type="button"
                onClick={handleCloseModal}
                className="rounded-full bg-slate-100 hover:bg-slate-200 px-4 py-1.5 text-sm font-semibold text-slate-600 transition-colors"
              >
                ปิด
              </button>
            </div>

            {status === 'success' ? (
              <div className="mt-6 flex flex-1 flex-col items-center justify-center text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 mb-6">
                  <svg xmlns="http://www.w3.org/2000/svg" className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <h4 className="text-2xl font-bold text-slate-900">ชำระเงินเรียบร้อย</h4>
                <p className="mt-2 text-base font-medium text-slate-600">เหรียญถูกเพิ่มเข้าบัญชีของคุณแล้ว</p>
                <button
                  type="button"
                  onClick={handleSuccessReturn}
                  className="focus-ring mt-8 min-h-[56px] w-full rounded-2xl bg-emerald-600 px-6 py-2 text-base font-bold text-white hover:bg-emerald-700 shadow-lg shadow-emerald-600/20 transition-all"
                >
                  กลับไปหน้าสร้างสติ๊กเกอร์
                </button>
              </div>
            ) : (
              <div className="mt-6 flex flex-1 flex-col items-center text-center">
                <p className="text-base font-medium text-slate-600">สแกน QR Code สำหรับ {selectedPackage.price}</p>
                <div className="mt-6 flex h-64 w-64 items-center justify-center rounded-[2rem] border-2 border-slate-100 bg-slate-50 shadow-inner">
                  {qrUrl ? (
                    <img src={qrUrl} alt="PromptPay QR" className="h-56 w-56 rounded-xl" />
                  ) : (
                    <span className="text-sm font-medium text-slate-400 flex flex-col items-center gap-2">
                      <svg className="animate-spin h-6 w-6 text-slate-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                      </svg>
                      กำลังสร้าง QR Code...
                    </span>
                  )}
                </div>
                <p className="mt-6 text-sm font-medium text-slate-500 flex items-center gap-2">
                  <span className="relative flex h-3 w-3">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
                  </span>
                  ระบบกำลังรอการชำระเงิน
                </p>
                <button
                  type="button"
                  onClick={handleManualCheck}
                  className="focus-ring mt-6 min-h-[56px] w-full rounded-2xl border-2 border-slate-200 bg-white px-6 py-2 text-base font-bold text-slate-700 hover:border-emerald-400 hover:text-emerald-600 transition-all shadow-sm"
                >
                  ฉันชำระเงินแล้ว
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </PageLayout>
  );
};

export default PaymentPage;
