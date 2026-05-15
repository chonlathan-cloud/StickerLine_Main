import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  ArrowLeft as BackIcon,
  Bell as NotificationIcon,
  Bot as RobotIcon,
  CheckCircle2 as CheckIcon,
  CreditCard as PaymentsIcon,
  Download as DownloadIcon,
  Heart as HeartIcon,
  Lock as LockIcon,
  MessageCircle as LineIcon,
  Monitor as HighQualityIcon,
  RotateCcw as RefreshIcon,
  ShoppingCart as PayIcon,
  Sparkles as SparklesIcon,
  Star as StarIcon,
  Unlock as UnlockIcon,
  Upload as UploadIcon,
  X as CloseIcon,
} from 'lucide-react';
import {
  ExtraVaultItemResponse,
  GenerationState,
  PaymentProductId,
  StickerSlotResponse,
  checkJobStatus,
  createPayment,
  downloadCurrentStickerForShare,
  finalizeCurrentStickerExport,
  getCurrentExtraVault,
  getCurrentStickers,
  getCurrentStickersDownloadUrl,
  getExtraVaultDownloadUrl,
  persistPendingPayment,
  resetCurrentStickers,
  startGeneration,
  uploadImage,
} from '../api/client';
import { StickerSheetConfig, StickerStyle } from '../types';
import { useOnlineStatus } from '../hooks/useOnlineStatus';
import { useAuth } from '../providers/AuthProvider';

type ProcessingStep = 'idle' | 'analyzing' | 'generating' | 'removing' | 'complete';

type StickerSlot = {
  id: string;
  url: string;
  locked: boolean;
};

type ExtraSlot = {
  id: string;
  replacedFromSlot: number | null;
  url: string | null;
  createdAt?: string | null;
};

type CheckoutProduct = PaymentProductId | null;

type CurrentGenerationPayload = {
  status: 'ok' | 'empty';
  job_id?: string | null;
  sticker_count?: number;
  result_slots?: StickerSlotResponse[];
  generation_state?: GenerationState;
  extra_vault_count?: number;
  extra_vault?: ExtraVaultItemResponse[];
};

const DEFAULT_STICKER_COUNT = 16;
const ALLOWED_STICKER_COUNTS = new Set([15, 16]);
const SAVE_TO_PHOTOS_PARAM = 'saveToPhotos';
const SAVE_TO_PHOTOS_PARAM_VALUE = '1';
const PROMPT_GUIDE_EXAMPLE =
  'A cute office cat sticker set with tired, stressed, rushed, confused, happy moods, laptop, documents, tiny Thai chat captions, clear character, transparent background';

const TEMPLATE_IMAGES = {
  MASCOT_LOGIN: '/assets/template/mascot-login.png',
  STICKER_PACK: '/assets/template/sticker-pack.png',
  CELEBRATION: '/assets/template/celebration.png',
  AVATAR: '/assets/template/avatar.png',
  STICKERS: Array.from({ length: 16 }, (_, index) =>
    `/assets/template/sticker-${String(index + 1).padStart(2, '0')}.png`,
  ),
};

const STYLE_OPTIONS: Array<{
  value: StickerStyle;
  id: '3D' | '2D';
  label: string;
  img: string;
}> = [
  { value: 'Pixar 3D', id: '3D', label: '3D Render', img: TEMPLATE_IMAGES.STICKERS[0] },
  { value: 'Chibi 2D', id: '2D', label: '2D Anime', img: TEMPLATE_IMAGES.STICKERS[5] },
];

const isSupportedStickerCount = (count: number) => ALLOWED_STICKER_COUNTS.has(count);

const buildSaveToPhotosBatchId = () => {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 17);
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  return `${timestamp}-${randomSuffix}`;
};

const buildStickerPngFileName = (index: number, batchId: string) =>
  `sticker-${batchId}-${String(index + 1).padStart(2, '0')}.png`;

const formatCountdown = (value?: string | null) => {
  if (!value) return null;
  const target = new Date(value).getTime();
  if (Number.isNaN(target)) return null;
  const diffMs = Math.max(0, target - Date.now());
  const totalMinutes = Math.ceil(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes} min`;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

const openDownloadUrl = (url: string) => {
  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

const isMobileDevice = () =>
  typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

const supportsFileShare = () =>
  typeof navigator !== 'undefined'
  && typeof navigator.share === 'function'
  && typeof File !== 'undefined';

const shouldResumeSaveToPhotosInExternalBrowser = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get(SAVE_TO_PHOTOS_PARAM) === SAVE_TO_PHOTOS_PARAM_VALUE;
};

const buildExternalBrowserSaveToPhotosUrl = () => {
  const url = new URL(window.location.href);
  url.searchParams.set(SAVE_TO_PHOTOS_PARAM, SAVE_TO_PHOTOS_PARAM_VALUE);
  return url.toString();
};

const clearSaveToPhotosIntent = () => {
  const url = new URL(window.location.href);
  url.searchParams.delete(SAVE_TO_PHOTOS_PARAM);
  window.history.replaceState({}, '', url.toString());
};

const isInLiffClient = () => {
  try {
    return typeof liff !== 'undefined' && liff.isInClient();
  } catch {
    return false;
  }
};

const isAndroidDevice = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

const Button = ({ children, variant = 'primary', className = '', ...props }: any) => {
  const base = 'h-[52px] px-8 rounded-full font-bold flex items-center justify-center gap-2 transition-all active:scale-95 duration-200 disabled:cursor-not-allowed disabled:opacity-50';
  const variants: Record<string, string> = {
    primary: 'bg-ai-gradient text-white shadow-[0_4px_12px_rgba(124,58,237,0.3)] hover:opacity-90',
    secondary: 'bg-surface-container text-on-surface border-2 border-border-light-purple hover:bg-surface-container-high',
    outline: 'border-2 border-primary text-primary hover:bg-primary/5',
    ghost: 'text-on-surface-variant hover:bg-surface-container',
    line: 'bg-[#06C755] text-white hover:opacity-90',
  };

  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

const Header = ({
  avatarSrc,
  attemptLabel,
  notificationCount,
}: {
  avatarSrc?: string;
  attemptLabel: string;
  notificationCount?: number;
}) => (
  <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 bg-surface border-b border-outline-variant/30 backdrop-blur-md">
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-full overflow-hidden shadow-sm shrink-0">
        <img src={avatarSrc || TEMPLATE_IMAGES.AVATAR} alt="User" className="w-full h-full object-cover" />
      </div>
      <h1 className="text-xl font-extrabold text-primary tracking-tight truncate">Mia-U-Sticker</h1>
    </div>
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary-container rounded-full shadow-sm">
        <SparklesIcon className="text-on-secondary-container w-5 h-5" />
        <span className="text-sm font-bold text-on-secondary-container">{attemptLabel}</span>
      </div>
      <button type="button" className="relative p-2 rounded-full hover:bg-surface-container transition-colors" aria-label="Trial notifications">
        <NotificationIcon className="text-primary w-6 h-6" />
        {notificationCount ? (
          <span className="absolute top-1 right-1 min-w-4 h-4 px-1 bg-error text-on-error text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-surface">
            {notificationCount}
          </span>
        ) : null}
      </button>
    </div>
  </header>
);

const LoadingOverlay = ({ headline, subtext, progress }: { headline: string; subtext: string; progress: number }) => (
  <div className="pointer-events-none absolute inset-0 flex items-end p-3">
    <div className="w-full rounded-2xl bg-black/30 p-3 text-white backdrop-blur-[3px]">
      <div className="flex items-center gap-2">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />
        <p className="text-sm font-semibold text-white">{headline}</p>
      </div>
      <p className="mt-1 text-xs text-white/90">{subtext}</p>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/30">
        <span className="block h-full rounded-full bg-secondary-container transition-all duration-500" style={{ width: `${progress}%` }} />
      </div>
    </div>
  </div>
);

const GeneratorView = ({
  config,
  loading,
  canGenerate,
  loadingHeadline,
  loadingSubtext,
  simulatedProgress,
  generateLabel,
  helperText,
  onUploadClick,
  onImageUpload,
  onStyleChange,
  onPromptChange,
  onGenerate,
  fileInputRef,
}: {
  config: StickerSheetConfig;
  loading: boolean;
  canGenerate: boolean;
  loadingHeadline: string;
  loadingSubtext: string;
  simulatedProgress: number;
  generateLabel: string;
  helperText?: string | null;
  onUploadClick: () => void;
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStyleChange: (style: StickerStyle) => void;
  onPromptChange: (prompt: string) => void;
  onGenerate: () => void;
  fileInputRef: React.RefObject<HTMLInputElement>;
}) => (
  <div className="flex flex-col gap-8 p-6">
    <section>
      <h3 className="text-lg font-bold mb-4">Base Image</h3>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={onImageUpload}
        className="sr-only"
      />
      <button
        type="button"
        onClick={onUploadClick}
        className="relative w-full overflow-hidden border-2 border-dashed border-outline-variant rounded-2xl aspect-video flex flex-col items-center justify-center bg-surface-container-low cursor-pointer hover:bg-surface-container transition-colors"
      >
        {config.base64Image ? (
          <img src={config.base64Image} alt="Uploaded source preview" className={`w-full h-full object-cover ${loading ? 'opacity-60' : ''}`} />
        ) : (
          <>
            <div className="p-4 bg-primary-container/10 rounded-full mb-3">
              <UploadIcon className="text-primary" />
            </div>
            <p className="font-bold text-on-surface">Upload Selfie</p>
            <p className="text-xs text-on-surface-variant">JPEG, PNG up to 5MB</p>
          </>
        )}
        {loading ? <LoadingOverlay headline={loadingHeadline} subtext={loadingSubtext} progress={simulatedProgress} /> : null}
      </button>
    </section>

    <section>
      <h3 className="text-lg font-bold mb-4">Choose Style</h3>
      <div className="grid grid-cols-2 gap-4">
        {STYLE_OPTIONS.map((styleOption) => (
          <button
            type="button"
            key={styleOption.id}
            onClick={() => onStyleChange(styleOption.value)}
            className={`relative cursor-pointer rounded-2xl overflow-hidden transition-all duration-300 ${config.style === styleOption.value ? 'ring-4 ring-primary ring-offset-2' : ''}`}
          >
            <img src={styleOption.img} alt={styleOption.label} className="w-full aspect-square object-cover" />
            <div className="absolute bottom-0 left-0 right-0 bg-black/40 backdrop-blur-sm p-2">
              <p className="text-white text-xs font-bold text-center">{styleOption.label}</p>
            </div>
          </button>
        ))}
      </div>
    </section>

    <section>
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-bold">Describe Details</h3>
      </div>
      <div className="bg-surface-container rounded-2xl p-4 border-2 border-border-light-purple min-h-[100px]">
        <textarea
          value={config.extraPrompt}
          placeholder="e.g. wearing a spacesuit, floating in a neon galaxy..."
          className="w-full bg-transparent border-none focus:ring-0 text-sm resize-none outline-none"
          rows={3}
          onChange={(e) => onPromptChange(e.target.value)}
        />
      </div>
      <div className="flex flex-wrap gap-2 mt-4">
        {['Cyberpunk City', 'Fairy Forest', 'Rock Star'].map((tag) => (
          <button
            type="button"
            key={tag}
            onClick={() => onPromptChange(config.extraPrompt ? `${config.extraPrompt}, ${tag}` : tag)}
            className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant cursor-pointer hover:bg-primary-container/10 transition-colors"
          >
            ✨ {tag}
          </button>
        ))}
      </div>
    </section>

    <Button className="w-full text-lg mt-4" onClick={onGenerate} disabled={loading || !canGenerate}>
      {loading ? <RefreshIcon className="animate-spin" /> : <SparklesIcon />}
      {generateLabel}
    </Button>
    {helperText ? <p className="text-sm text-on-surface-variant text-center">{helperText}</p> : null}
  </div>
);

const LimitModal = ({
  cooldownLabel,
  onUnlock,
  onWait,
  isOpeningPayment,
}: {
  cooldownLabel?: string | null;
  onUnlock: () => void;
  onWait: () => void;
  isOpeningPayment: boolean;
}) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ scale: 0.9, opacity: 0 }}
      className="bg-white rounded-[32px] p-8 w-full max-w-sm text-center shadow-2xl"
    >
      <div className="w-20 h-20 bg-primary-container/10 rounded-full flex items-center justify-center mx-auto mb-6">
        <RobotIcon className="text-primary text-4xl animate-bounce" />
      </div>
      <h3 className="text-2xl font-extrabold mb-2">Limit Reached! (20/20)</h3>
      <p className="text-on-surface-variant text-sm mb-8">You've used all trial attempts for today. Unlock your final pack or wait for reset.</p>

      <Button className="w-full mb-4" onClick={onUnlock} disabled={isOpeningPayment}>
        <PayIcon />
        {isOpeningPayment ? 'Opening Beam...' : 'Unlock & Save Pack (199 THB)'}
      </Button>
      <button type="button" className="text-primary font-bold hover:underline" onClick={onWait}>Wait for Reset</button>

      <div className="mt-8 flex flex-col items-center gap-2">
        <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Reset In</p>
        <div className="px-6 py-2 bg-surface-container rounded-full border border-border-light-purple">
          <span className="font-bold text-primary tabular-nums">{cooldownLabel ?? '24:00:00'}</span>
        </div>
      </div>
    </motion.div>
  </div>
);

const GridView = ({
  stickerSlots,
  selectedCount,
  finalPackPaid,
  loading,
  helperText,
  error,
  onToggle,
  onRegenerate,
  onContinue,
  onSelectAll,
  onClearAll,
}: {
  stickerSlots: StickerSlot[];
  selectedCount: number;
  finalPackPaid: boolean;
  loading: boolean;
  helperText?: string | null;
  error?: string | null;
  onToggle: (index: number) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) => (
  <div className="p-6">
    <div className="text-center mb-8">
      <h2 className="text-2xl font-extrabold mb-1">The Magic Grid</h2>
      <p className="text-on-surface-variant text-sm">Tap the stickers you want to keep. They are so bouncy!</p>
    </div>

    <div className="mb-4 flex justify-center gap-2">
      <button type="button" onClick={onSelectAll} className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant hover:bg-primary-container/10">
        Keep All
      </button>
      <button type="button" onClick={onClearAll} className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant hover:bg-primary-container/10">
        Generate All Again
      </button>
    </div>

    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stickerSlots.map((slot, index) => {
        const isSelected = slot.locked;
        return (
          <motion.button
            type="button"
            key={slot.id}
            whileTap={{ scale: 0.95 }}
            onClick={() => onToggle(index)}
            disabled={loading || finalPackPaid}
            className={`relative aspect-square rounded-[24px] overflow-hidden transition-all duration-300 cursor-pointer disabled:cursor-not-allowed ${isSelected ? 'border-ai-gradient shadow-lg scale-100' : 'border-2 border-border-light-purple opacity-60 grayscale-[40%] scale-[0.98]'}`}
          >
            <img src={slot.url} alt={`Sticker ${index + 1}`} className={`w-full h-full object-contain bg-white ${!isSelected && 'blur-[1px]'}`} />
            <div className={`absolute top-2 right-2 w-8 h-8 rounded-full shadow-md flex items-center justify-center transition-all ${isSelected ? 'bg-white' : 'bg-white/40'}`}>
              {isSelected ? <CheckIcon className="text-secondary-container w-6 h-6" /> : <LockIcon className="text-on-surface-variant w-4 h-4" />}
            </div>
          </motion.button>
        );
      })}
    </div>

    {helperText ? <p className="mt-5 text-sm text-center text-on-surface-variant">{helperText}</p> : null}
    {error ? <p className="mt-3 rounded-2xl bg-error-container px-4 py-3 text-sm font-bold text-on-error-container">{error}</p> : null}

    <div className="mt-12 flex flex-col gap-4 sticky bottom-6">
      <Button variant="secondary" className="w-full" onClick={onRegenerate} disabled={loading || finalPackPaid}>
        {loading ? <RefreshIcon className="animate-spin" /> : <RefreshIcon />}
        Regenerate Unselected
      </Button>
      <Button variant="primary" className="w-full" onClick={onContinue} disabled={loading}>
        <CheckIcon />
        {finalPackPaid ? 'Save to Photos' : `Keep & Continue (${selectedCount})`}
      </Button>
    </div>
  </div>
);

const CheckoutView = ({
  productId,
  finalPackPaid,
  extraCount,
  selectedExtraCount,
  onBack,
  onClose,
  onPay,
  onSave,
  isBusy,
}: {
  productId: PaymentProductId;
  finalPackPaid: boolean;
  extraCount: number;
  selectedExtraCount: number;
  onBack: () => void;
  onClose: () => void;
  onPay: () => void;
  onSave: () => void;
  isBusy: boolean;
}) => {
  const isExtra = productId === 'extra_pack_99';
  const title = isExtra ? 'Extra Vault' : 'Final Pack';
  const price = isExtra ? '99 THB' : '199 THB';
  const buttonLabel = isExtra
    ? isBusy ? 'Opening Beam...' : 'Pay 99 THB'
    : finalPackPaid
      ? isBusy ? 'Preparing...' : 'Save to Photos'
      : isBusy ? 'Opening Beam...' : 'Pay & Save Now';
  const features = isExtra
    ? [
        { icon: <HeartIcon />, text: `Unlock selected extras (${selectedExtraCount || extraCount})` },
        { icon: <HighQualityIcon />, text: 'Export selected hidden gems' },
        { icon: <UnlockIcon />, text: 'Extra pack is separate from final 16' },
      ]
    : [
        { icon: <HeartIcon />, text: 'Save all 16 unique stickers' },
        { icon: <HighQualityIcon />, text: 'High-resolution export' },
        { icon: <UnlockIcon />, text: 'Reset attempts after successful save' },
      ];

  return (
    <div className="flex flex-col gap-8 p-6 max-w-md mx-auto">
      <div className="flex items-center justify-between">
        <Button variant="ghost" className="p-0 h-10 w-10" onClick={onBack}><BackIcon /></Button>
        <h2 className="text-xl font-extrabold text-primary">Unlock Pack</h2>
        <Button variant="ghost" className="p-0 h-10 w-10" onClick={onClose}><CloseIcon /></Button>
      </div>

      <div className="flex flex-col items-center text-center">
        <div className="w-48 h-48 rounded-[40px] bg-white border-4 border-border-light-purple shadow-xl mb-6 relative overflow-hidden flex items-center justify-center p-4">
          <img src={TEMPLATE_IMAGES.STICKER_PACK} alt="Pack" className="w-full h-full object-contain" />
          <div className="absolute -top-2 -right-2 bg-secondary-container p-2 rounded-full shadow-lg rotate-12">
            <StarIcon className="text-on-secondary-container" />
          </div>
        </div>
        <h3 className="text-2xl font-extrabold mb-2">{title}</h3>
        <div className="px-8 py-2 bg-surface-container rounded-full border-2 border-border-light-purple">
          <span className="text-3xl font-black text-ai-gradient italic">{price}</span>
        </div>
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

      <div className="mt-auto">
        <Button className="w-full py-6 text-xl" onClick={isExtra || !finalPackPaid ? onPay : onSave} disabled={isBusy}>
          {isBusy ? <RefreshIcon className="animate-spin" /> : isExtra || !finalPackPaid ? <PayIcon /> : <DownloadIcon />}
          {buttonLabel}
        </Button>
        <p className="text-center text-xs text-on-surface-variant mt-4 opacity-70">Secure payment powered by Beam.</p>
      </div>
    </div>
  );
};

const SuccessView = ({
  stickerSlots,
  extraSlots,
  selectedExtraIds,
  extraPackPaid,
  isBusy,
  onToggleExtra,
  onSelectFirst16,
  onClearExtras,
  onPayExtra,
  onDownloadExtras,
  onDownloadFinal,
  onOpenStickerMaker,
}: {
  stickerSlots: StickerSlot[];
  extraSlots: ExtraSlot[];
  selectedExtraIds: string[];
  extraPackPaid: boolean;
  isBusy: boolean;
  onToggleExtra: (id: string) => void;
  onSelectFirst16: () => void;
  onClearExtras: () => void;
  onPayExtra: () => void;
  onDownloadExtras: () => void;
  onDownloadFinal: () => void;
  onOpenStickerMaker: () => void;
}) => {
  const [showVault, setShowVault] = useState(false);
  const selectedCount = selectedExtraIds.length;

  return (
    <div className="flex flex-col gap-10 p-6 min-h-screen">
      <section className="text-center mt-8">
        <div className="w-32 h-32 bg-success-teal/10 rounded-full flex items-center justify-center mx-auto relative mb-8 shadow-inner">
          <CheckIcon className="text-success-teal text-6xl" />
          <div className="absolute -bottom-4 w-24 h-24 rounded-full overflow-hidden border-4 border-background shadow-lg scale-110">
            <img src={TEMPLATE_IMAGES.CELEBRATION} alt="Celebration" className="w-full h-full object-cover" />
          </div>
        </div>
        <h2 className="text-3xl font-extrabold text-primary mb-2">Payment Success!</h2>
        <p className="text-on-surface-variant">Your stickers are ready for the world.</p>
      </section>

      <div className="bg-white rounded-[32px] p-6 border-2 border-border-light-purple shadow-sm space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <SparklesIcon className="text-primary" />
            <h3 className="font-bold text-lg">Main Collection</h3>
          </div>
          <span className="px-3 py-1 bg-primary-container text-white text-xs font-bold rounded-full">{stickerSlots.length || 16} Stickers</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {(stickerSlots.length ? stickerSlots : TEMPLATE_IMAGES.STICKERS.map((url, index) => ({ id: String(index), url, locked: true }))).slice(0, 3).map((slot) => (
            <img key={slot.id} src={slot.url} className="aspect-square object-contain rounded-xl bg-surface-container" alt="Saved sticker" />
          ))}
          <div className="aspect-square bg-surface-container flex items-center justify-center rounded-xl font-bold text-primary">+13</div>
        </div>
        <div className="flex flex-col gap-3">
          <Button variant="secondary" className="w-full h-12" onClick={onDownloadFinal}><DownloadIcon /> Download ZIP</Button>
          <Button variant="line" className="w-full h-12 text-sm" onClick={onOpenStickerMaker}><LineIcon /> Open LINE Sticker Maker</Button>
        </div>
      </div>

      {extraSlots.length ? (
        <section className="pb-32">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <StarIcon className="text-secondary-container" />
              <h3 className="font-bold text-lg">The Extra Vault</h3>
            </div>
            <span className="text-xs font-bold text-on-surface-variant">{selectedCount}/16 selected</span>
          </div>
          <div className="grid grid-cols-2 gap-4">
            {extraSlots.map((slot, index) => {
              const selected = selectedExtraIds.includes(slot.id);
              return (
                <button
                  type="button"
                  key={slot.id}
                  onClick={() => onToggleExtra(slot.id)}
                  disabled={extraPackPaid || isBusy}
                  className={`relative aspect-square rounded-3xl overflow-hidden cursor-pointer group ${selected ? 'ring-4 ring-secondary-container ring-offset-2' : ''}`}
                >
                  {slot.url ? (
                    <img src={slot.url} alt={`Extra sticker ${index + 1}`} className="w-full h-full object-contain bg-white transition-transform group-hover:scale-105" />
                  ) : (
                    <div className="w-full h-full bg-surface-container flex items-center justify-center text-sm font-bold text-on-surface-variant">Extra</div>
                  )}
                  <div className={`absolute inset-0 ${selected ? 'bg-primary/10' : 'bg-black/20 backdrop-blur-[2px]'} flex items-center justify-center`}>
                    {selected ? <CheckIcon className="text-secondary-container" /> : <LockIcon className="text-white" />}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" onClick={onSelectFirst16} disabled={extraPackPaid} className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant">
              Select first 16
            </button>
            <button type="button" onClick={onClearExtras} disabled={extraPackPaid} className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant">
              Clear
            </button>
          </div>
        </section>
      ) : null}

      {extraSlots.length ? (
        <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/80 backdrop-blur-md border-t border-border-light-purple z-40">
          <div className="max-w-md mx-auto flex items-center gap-4">
            <div className="flex-1">
              <p className="text-xs text-on-surface-variant font-bold">
                {extraPackPaid ? 'Extra Vault unlocked' : `Unlock selected (${selectedCount})`}
              </p>
              <p className="text-xl font-black text-primary italic">99 THB</p>
            </div>
            <Button
              onClick={extraPackPaid ? onDownloadExtras : () => setShowVault(true)}
              disabled={isBusy || selectedCount === 0}
              className="px-10"
            >
              {isBusy ? <RefreshIcon className="animate-spin" /> : <PaymentsIcon />}
              {extraPackPaid ? 'Download' : 'Payment 99 THB'}
            </Button>
          </div>
        </div>
      ) : null}

      <AnimatePresence>
        {showVault && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
            <motion.div
              initial={{ y: 50, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 50, opacity: 0 }}
              className="bg-white rounded-[32px] p-8 w-full max-w-sm text-center shadow-2xl relative"
            >
              <div className="w-24 h-24 mx-auto mb-6 relative">
                <img src={extraSlots.find((slot) => selectedExtraIds.includes(slot.id))?.url || TEMPLATE_IMAGES.STICKERS[2]} className="w-full h-full object-contain rounded-full border-4 border-secondary-container bg-white" alt="Selected extra preview" />
                <div className="absolute -top-1 -right-1 bg-secondary-container p-1 rounded-full"><StarIcon className="text-xs" /></div>
              </div>
              <h3 className="text-2xl font-extrabold mb-1">Unlock Extra Vault</h3>
              <div className="text-2xl font-black text-primary mb-4 italic">99 THB</div>
              <p className="text-sm text-on-surface-variant mb-8">Secure all your hidden gems and save them to your gallery forever.</p>

              <div className="space-y-3 mb-8">
                <div className="flex items-center justify-between p-4 rounded-2xl border-2 border-primary bg-primary/5">
                  <div className="flex items-center gap-3 font-bold"><PayIcon className="text-primary" /> Beam Payment</div>
                  <div className="w-5 h-5 rounded-full border-4 border-primary bg-white" />
                </div>
              </div>

              <Button className="w-full mb-4" onClick={onPayExtra} disabled={isBusy || selectedCount === 0}>
                {isBusy ? <RefreshIcon className="animate-spin" /> : <PayIcon />}
                Pay 99 THB
              </Button>
              <button type="button" className="text-on-surface-variant font-bold text-sm" onClick={() => setShowVault(false)}>Cancel</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const GeneratePage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [config, setConfig] = useState<StickerSheetConfig>({
    base64Image: '',
    size: '2K',
    aspectRatio: '1:1',
    extraPrompt: '',
    style: 'Pixar 3D',
  });
  const [loading, setLoading] = useState(false);
  const [processingStep, setProcessingStep] = useState<ProcessingStep>('idle');
  const [simulatedStickerCount, setSimulatedStickerCount] = useState(1);
  const [generationTargetCount, setGenerationTargetCount] = useState(DEFAULT_STICKER_COUNT);
  const [error, setError] = useState<string | null>(null);
  const [stickerSlots, setStickerSlots] = useState<StickerSlot[]>([]);
  const [extraSlots, setExtraSlots] = useState<ExtraSlot[]>([]);
  const [selectedExtraIds, setSelectedExtraIds] = useState<string[]>([]);
  const [generationState, setGenerationState] = useState<GenerationState | null>(null);
  const [checkoutProduct, setCheckoutProduct] = useState<CheckoutProduct>(null);
  const [isCreatingPayment, setIsCreatingPayment] = useState<PaymentProductId | null>(null);
  const [isSavingFinal, setIsSavingFinal] = useState(false);
  const [isExtraExporting, setIsExtraExporting] = useState(false);
  const [dismissedLimit, setDismissedLimit] = useState(false);
  const [clockTick, setClockTick] = useState(0);

  const hydrateCurrentGeneration = (data: CurrentGenerationPayload) => {
    const now = Date.now();
    const resultSlots = data.result_slots ?? [];
    const extraVault = data.extra_vault ?? [];

    if (data.generation_state) {
      setGenerationState(data.generation_state);
    }

    if (data.status === 'ok' && isSupportedStickerCount(resultSlots.length)) {
      const slots = resultSlots.map((slot, index) => ({
        id: `${data.job_id ?? now}-${index}`,
        url: slot.url,
        locked: slot.locked,
      }));
      setStickerSlots(slots);
      setGenerationTargetCount(slots.length);
    } else if (data.status === 'empty') {
      setStickerSlots([]);
      setGenerationTargetCount(DEFAULT_STICKER_COUNT);
    }

    const mappedExtras = extraVault.map((item, index) => ({
      id: item.id || `${data.job_id ?? now}-extra-${index}`,
      replacedFromSlot: typeof item.replaced_from_slot === 'number' ? item.replaced_from_slot : null,
      url: item.url ?? null,
      createdAt: item.created_at ?? null,
    }));
    setExtraSlots(mappedExtras);
    setSelectedExtraIds((previous) => {
      const valid = previous.filter((id) => mappedExtras.some((slot) => slot.id === id));
      return valid.length ? valid : mappedExtras.slice(0, 16).map((slot) => slot.id);
    });
  };

  useEffect(() => {
    if (!profile?.userId) return;
    getCurrentStickers(profile.userId)
      .then(hydrateCurrentGeneration)
      .catch(() => null);
  }, [profile?.userId]);

  useEffect(() => {
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 60000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!loading) {
      setSimulatedStickerCount(1);
      return;
    }
    if (processingStep === 'analyzing') {
      setSimulatedStickerCount(1);
      return;
    }
    if (processingStep === 'removing') {
      setSimulatedStickerCount(generationTargetCount);
      return;
    }
    if (processingStep !== 'generating') return;

    const startedAt = Date.now();
    const interval = window.setInterval(() => {
      const elapsedSeconds = (Date.now() - startedAt) / 1000;
      const nextCount = Math.min(generationTargetCount, Math.max(1, Math.floor(elapsedSeconds * 1.35) + 1));
      setSimulatedStickerCount(nextCount);
    }, 650);
    return () => window.clearInterval(interval);
  }, [generationTargetCount, loading, processingStep]);

  useEffect(() => {
    if (!shouldResumeSaveToPhotosInExternalBrowser() || isInLiffClient()) return;
    clearSaveToPhotosIntent();
  }, []);

  const attemptCount = generationState?.generation_count ?? 0;
  const attemptLimit = generationState?.generation_limit ?? 20;
  const remainingAttempts = generationState?.remaining_attempts ?? attemptLimit;
  const finalPackPaid = Boolean(generationState?.final_pack_paid);
  const finalPackExported = Boolean(generationState?.final_pack_exported);
  const extraPackPaid = Boolean(generationState?.extra_pack_paid);
  const isGenerationLocked = Boolean(generationState?.is_generation_locked);
  const cooldownLabel = useMemo(
    () => formatCountdown(generationState?.generation_cooldown_until),
    [clockTick, generationState?.generation_cooldown_until],
  );
  const lockedCount = stickerSlots.filter((slot) => slot.locked).length;
  const unlockedCount = stickerSlots.length ? stickerSlots.length - lockedCount : DEFAULT_STICKER_COUNT;
  const canGenerate = Boolean(config.base64Image) && !isGenerationLocked && !(finalPackPaid && !finalPackExported);
  const attemptLabel = `${attemptCount}/${attemptLimit}`;
  const notificationCount = generationState?.warning?.remaining != null ? Math.max(0, generationState.warning.remaining) : undefined;

  const loadingHeadline =
    processingStep === 'analyzing'
      ? 'Analyzing selfie'
      : processingStep === 'generating'
        ? `Generating ${simulatedStickerCount}/${generationTargetCount}`
        : processingStep === 'removing'
          ? 'Preparing transparent PNG'
          : 'Ready';

  const loadingSubtext =
    processingStep === 'analyzing'
      ? 'Checking face detail and prompt safety'
      : processingStep === 'generating'
        ? 'Rendering your sticker set'
        : processingStep === 'removing'
          ? 'Cleaning background for LINE-ready assets'
          : 'Ready';

  const simulatedProgress =
    processingStep === 'analyzing'
      ? 12
      : processingStep === 'generating'
        ? 16 + Math.round((simulatedStickerCount / generationTargetCount) * 64)
        : processingStep === 'removing'
          ? 92
          : processingStep === 'complete'
            ? 100
            : 0;

  const helperText = generationState?.warning?.message
    || (isGenerationLocked ? `Reset in ${cooldownLabel ?? '24h'} or unlock the final pack.` : null);

  const currentView: 'generator' | 'grid' | 'checkout' | 'success' = checkoutProduct
    ? 'checkout'
    : finalPackExported
      ? 'success'
      : stickerSlots.length
        ? (finalPackPaid ? 'checkout' : 'grid')
        : 'generator';

  const activeCheckoutProduct = checkoutProduct ?? (finalPackPaid && !finalPackExported ? 'final_pack_199' : null);

  const openImagePicker = () => fileInputRef.current?.click();

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setError('Please upload an image file only.');
      return;
    }

    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result !== 'string') return;
      setConfig((previous) => ({ ...previous, base64Image: reader.result }));
      setStickerSlots([]);
      setExtraSlots([]);
      setSelectedExtraIds([]);
      setGenerationState(null);
      setCheckoutProduct(null);
      setError(null);
      if (profile?.userId) {
        resetCurrentStickers(profile.userId).catch(() => null);
      }
    };
    reader.readAsDataURL(file);
  };

  const generateSheet = async () => {
    if (!isOnline) {
      setError('You are offline. Please connect to the internet and try again.');
      return;
    }
    if (!profile?.userId) {
      setError('Please log in with LINE before generating stickers.');
      return;
    }
    if (!config.base64Image) {
      setError('Please upload a source image first.');
      return;
    }

    const canReuseExisting = isSupportedStickerCount(stickerSlots.length);
    const unlockedSlots = canReuseExisting ? stickerSlots.filter((slot) => !slot.locked).length : DEFAULT_STICKER_COUNT;
    if (canReuseExisting && unlockedSlots === 0) {
      setError('Select at least one sticker to regenerate.');
      return;
    }

    setGenerationTargetCount(unlockedSlots);
    setLoading(true);
    setProcessingStep('analyzing');
    setError(null);
    setDismissedLimit(false);

    const pollUntilComplete = async (jobId: string) => {
      const maxAttempts = 180;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const statusResp = await checkJobStatus(jobId);
        if (statusResp.status === 'completed' && statusResp.result_slots) {
          if (statusResp.generation_state) setGenerationState(statusResp.generation_state);
          return statusResp;
        }
        if (statusResp.status === 'failed') {
          throw new Error(statusResp.error || 'Generation failed.');
        }
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      throw new Error('Generation is taking longer than expected. Please try again later.');
    };

    try {
      const uploadResp = await uploadImage(config.base64Image, `selfie_${Date.now()}.jpg`);
      const lockedIndices = stickerSlots
        .map((slot, index) => (slot.locked ? index : null))
        .filter((index): index is number => index !== null);

      setProcessingStep('generating');
      const jobResp = await startGeneration(profile.userId, uploadResp.gcs_uri, config.style, config.extraPrompt, lockedIndices);
      if (jobResp.generation_state) setGenerationState(jobResp.generation_state);

      const resolved = jobResp.status !== 'completed' && jobResp.job_id ? await pollUntilComplete(jobResp.job_id) : jobResp;
      if (resolved.status !== 'completed' || !resolved.result_slots || !isSupportedStickerCount(resolved.result_slots.length)) {
        throw new Error('Generation failed or returned unexpected status.');
      }

      setProcessingStep('removing');
      const currentData = await getCurrentStickers(profile.userId);
      hydrateCurrentGeneration(currentData);
      setProcessingStep('complete');
    } catch (err: any) {
      const backendDetail = err?.response?.data?.detail;
      if (backendDetail?.generation_state) {
        setGenerationState(backendDetail.generation_state);
      }
      if (backendDetail?.generation_state?.is_generation_locked) {
        setDismissedLimit(false);
      }
      const message = backendDetail?.generation_state?.warning?.message
        || (backendDetail?.error_code === 'generation_limit_reached'
          ? 'Limit reached. Unlock 199 THB to save this sticker pack.'
          : typeof backendDetail === 'string'
            ? backendDetail
            : err?.message || 'Error connecting to server.');
      setError(message);
    } finally {
      setLoading(false);
      setProcessingStep('idle');
    }
  };

  const toggleStickerLock = (index: number) => {
    setStickerSlots((previous) =>
      previous.map((slot, slotIndex) => (slotIndex === index ? { ...slot, locked: !slot.locked } : slot)),
    );
    setError(null);
  };

  const beginPayment = async (productId: PaymentProductId, selectedIds: string[] = []) => {
    if (!profile?.userId) {
      setError('Please log in with LINE before payment.');
      return;
    }
    try {
      setIsCreatingPayment(productId);
      setError(null);
      const result = await createPayment(profile.userId, productId, {
        cycleId: generationState?.cycle_id,
        selectedExtraIds: selectedIds,
      });
      persistPendingPayment(
        result.payment_link_id,
        result.checkout_url,
        result.product_id,
        result.expires_at,
        result.selected_extra_ids ?? selectedIds,
      );
      window.location.assign(result.checkout_url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Could not create Beam payment link.');
    } finally {
      setIsCreatingPayment(null);
    }
  };

  const finalizeFinalPackExport = async () => {
    if (!profile?.userId) return;
    const result = await finalizeCurrentStickerExport(profile.userId);
    setGenerationState(result.generation_state);
    const mappedExtras = (result.extra_vault ?? []).map((item) => ({
      id: item.id,
      replacedFromSlot: typeof item.replaced_from_slot === 'number' ? item.replaced_from_slot : null,
      url: item.url,
      createdAt: item.created_at ?? null,
    }));
    setExtraSlots(mappedExtras);
    setSelectedExtraIds(mappedExtras.slice(0, 16).map((slot) => slot.id));
    setCheckoutProduct(null);
  };

  const handleSaveFinalPack = async () => {
    if (!profile?.userId) return;
    if (!finalPackPaid) {
      setCheckoutProduct('final_pack_199');
      return;
    }

    if (isAndroidDevice() && isInLiffClient()) {
      window.location.assign(buildExternalBrowserSaveToPhotosUrl());
      return;
    }

    try {
      setIsSavingFinal(true);
      setError(null);
      if (isMobileDevice() && supportsFileShare()) {
        const batchId = buildSaveToPhotosBatchId();
        const files = await Promise.all(
          Array.from({ length: stickerSlots.length || DEFAULT_STICKER_COUNT }, async (_, index) => {
            const blob = await downloadCurrentStickerForShare(profile.userId, index);
            return new File([blob], buildStickerPngFileName(index, batchId), { type: 'image/png' });
          }),
        );
        const canShare = typeof navigator.canShare === 'function' ? navigator.canShare({ files }) : true;
        if (canShare) {
          await navigator.share({ files, title: 'Mia-U-Sticker Final Pack' });
          await finalizeFinalPackExport();
          return;
        }
      }

      const { url } = await getCurrentStickersDownloadUrl(profile.userId);
      openDownloadUrl(url);
      await finalizeFinalPackExport();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.generation_state) setGenerationState(detail.generation_state);
      if (detail?.error_code === 'payment_required') {
        setCheckoutProduct('final_pack_199');
        setError('Please unlock Final Pack 199 THB before saving.');
      } else {
        setError(typeof detail === 'string' ? detail : err?.message || 'Save to Photos failed.');
      }
    } finally {
      setIsSavingFinal(false);
    }
  };

  const handleDownloadFinalAgain = async () => {
    if (!profile?.userId) return;
    try {
      const { url } = await getCurrentStickersDownloadUrl(profile.userId);
      openDownloadUrl(url);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Could not download final pack.');
    }
  };

  const refreshExtraVault = async () => {
    if (!profile?.userId) return;
    const data = await getCurrentExtraVault(profile.userId);
    setGenerationState(data.generation_state);
    const mappedExtras = data.extra_vault.map((item) => ({
      id: item.id,
      replacedFromSlot: typeof item.replaced_from_slot === 'number' ? item.replaced_from_slot : null,
      url: item.url,
      createdAt: item.created_at ?? null,
    }));
    setExtraSlots(mappedExtras);
    setSelectedExtraIds((previous) => {
      const valid = previous.filter((id) => mappedExtras.some((slot) => slot.id === id));
      return valid.length ? valid : mappedExtras.slice(0, 16).map((slot) => slot.id);
    });
  };

  const toggleExtraSelection = (id: string) => {
    setSelectedExtraIds((previous) => {
      if (previous.includes(id)) return previous.filter((selectedId) => selectedId !== id);
      if (previous.length >= 16) {
        setError('Select up to 16 extra stickers.');
        return previous;
      }
      setError(null);
      return [...previous, id];
    });
  };

  const handleBuyExtraPack = async () => {
    if (selectedExtraIds.length === 0) {
      setError('Select at least one extra sticker before payment.');
      return;
    }
    await beginPayment('extra_pack_99', selectedExtraIds);
  };

  const handleDownloadExtras = async () => {
    if (!profile?.userId) return;
    const idsToExport = generationState?.extra_pack_selected_ids?.length
      ? generationState.extra_pack_selected_ids
      : selectedExtraIds;
    if (idsToExport.length === 0) {
      setError('Select at least one extra sticker before export.');
      return;
    }
    try {
      setIsExtraExporting(true);
      const { url, generation_state } = await getExtraVaultDownloadUrl(profile.userId, idsToExport);
      setGenerationState(generation_state);
      openDownloadUrl(url);
      await refreshExtraVault().catch(() => null);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.generation_state) setGenerationState(detail.generation_state);
      setError(detail?.error_code === 'payment_required'
        ? 'Please unlock Extra Pack 99 THB before export.'
        : typeof detail === 'string'
          ? detail
          : err?.message || 'Failed to export Extra Vault.');
    } finally {
      setIsExtraExporting(false);
    }
  };

  const handleOpenStickerMaker = () => {
    window.open('https://creator.line.me/stickermaker/', '_blank', 'noopener,noreferrer');
  };

  const renderView = () => {
    if (currentView === 'checkout' && activeCheckoutProduct) {
      return (
        <CheckoutView
          productId={activeCheckoutProduct}
          finalPackPaid={finalPackPaid}
          extraCount={extraSlots.length}
          selectedExtraCount={selectedExtraIds.length}
          onBack={() => setCheckoutProduct(null)}
          onClose={() => setCheckoutProduct(null)}
          onPay={() => beginPayment(activeCheckoutProduct, activeCheckoutProduct === 'extra_pack_99' ? selectedExtraIds : [])}
          onSave={handleSaveFinalPack}
          isBusy={isCreatingPayment === activeCheckoutProduct || isSavingFinal}
        />
      );
    }

    if (currentView === 'success') {
      return (
        <SuccessView
          stickerSlots={stickerSlots}
          extraSlots={extraSlots}
          selectedExtraIds={selectedExtraIds}
          extraPackPaid={extraPackPaid}
          isBusy={isCreatingPayment === 'extra_pack_99' || isExtraExporting}
          onToggleExtra={toggleExtraSelection}
          onSelectFirst16={() => setSelectedExtraIds(extraSlots.slice(0, 16).map((slot) => slot.id))}
          onClearExtras={() => setSelectedExtraIds([])}
          onPayExtra={handleBuyExtraPack}
          onDownloadExtras={handleDownloadExtras}
          onDownloadFinal={handleDownloadFinalAgain}
          onOpenStickerMaker={handleOpenStickerMaker}
        />
      );
    }

    if (currentView === 'grid') {
      return (
        <GridView
          stickerSlots={stickerSlots}
          selectedCount={lockedCount}
          finalPackPaid={finalPackPaid}
          loading={loading}
          helperText={helperText}
          error={error}
          onToggle={toggleStickerLock}
          onRegenerate={generateSheet}
          onContinue={() => setCheckoutProduct('final_pack_199')}
          onSelectAll={() => setStickerSlots((previous) => previous.map((slot) => ({ ...slot, locked: true })))}
          onClearAll={() => setStickerSlots((previous) => previous.map((slot) => ({ ...slot, locked: false })))}
        />
      );
    }

    return (
      <GeneratorView
        config={config}
        loading={loading}
        canGenerate={canGenerate}
        loadingHeadline={loadingHeadline}
        loadingSubtext={loadingSubtext}
        simulatedProgress={simulatedProgress}
        generateLabel={loading ? loadingHeadline : 'Generate'}
        helperText={helperText || error}
        onUploadClick={openImagePicker}
        onImageUpload={handleImageUpload}
        onStyleChange={(style) => setConfig((previous) => ({ ...previous, style }))}
        onPromptChange={(prompt) => setConfig((previous) => ({ ...previous, extraPrompt: prompt }))}
        onGenerate={generateSheet}
        fileInputRef={fileInputRef}
      />
    );
  };

  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      {currentView !== 'checkout' ? (
        <Header
          avatarSrc={profile?.pictureUrl}
          attemptLabel={attemptLabel}
          notificationCount={notificationCount}
        />
      ) : null}

      <main className="max-w-xl mx-auto pb-12 overflow-x-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentView}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>
      </main>

      <AnimatePresence>
        {currentView !== 'checkout' && isGenerationLocked && !finalPackPaid && !dismissedLimit ? (
          <LimitModal
            cooldownLabel={cooldownLabel}
            onUnlock={() => setCheckoutProduct('final_pack_199')}
            onWait={() => setDismissedLimit(true)}
            isOpeningPayment={isCreatingPayment === 'final_pack_199'}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export default GeneratePage;
