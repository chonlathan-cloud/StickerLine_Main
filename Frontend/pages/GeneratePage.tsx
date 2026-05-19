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
  GenerationWarning,
  PaymentProductId,
  StickerSlotResponse,
  checkJobStatus,
  createPayment,
  downloadCurrentStickerForShare,
  downloadExtraVaultStickerForShare,
  finalizeExtraVaultExport,
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
const AI_CAPACITY_ERROR_CODE = 'ai_capacity_exhausted';
const AI_CAPACITY_ERROR_MESSAGE = 'ระบบหนาแน่น กรุณารอสักครู่แล้วลองใหม่';
const PROMPT_GUIDE_EXAMPLE =
  'A cute office cat sticker set with tired, stressed, rushed, confused, happy moods, laptop, documents, tiny Thai chat captions, clear character, transparent background';
const PROMPT_CHIP_GROUPS = [
  {
    label: 'Mood',
    chips: ['Happy', 'Tired', 'Angry', 'Confused', 'Love'],
  },
  {
    label: 'Scene',
    chips: ['Cyberpunk City', 'Fairy Forest', 'Office', 'Cafe', 'Space'],
  },
  {
    label: 'Props',
    chips: ['Laptop', 'Coffee', 'Money', 'Phone', 'Documents'],
  },
  {
    label: 'Caption',
    chips: ['Thai chat captions', 'No text', 'Funny short text'],
  },
] as const;
type PromptChipGroupLabel = (typeof PROMPT_CHIP_GROUPS)[number]['label'];

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

const buildExtraPngFileName = (index: number, batchId: string) =>
  `extra-sticker-${batchId}-${String(index + 1).padStart(2, '0')}.png`;

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

const formatRetryCountdown = (seconds: number) => {
  const totalSeconds = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  if (minutes <= 0) return `${remainingSeconds}s`;
  return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
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

const canUseNativeFileShare = () => {
  if (!isMobileDevice() || !supportsFileShare()) return false;
  if (typeof navigator.canShare !== 'function') return true;
  try {
    const probeFile = new File(['probe'], 'sticker-probe.png', { type: 'image/png' });
    return navigator.canShare({ files: [probeFile] });
  } catch {
    return false;
  }
};

const formatUserFacingWarning = (warning?: GenerationWarning | null) => {
  if (!warning) return null;
  if (warning.level === 'gentle') {
    return 'ชุดนี้ใกล้พร้อมบันทึกแล้ว คุณยังปรับและสร้างต่อได้ตามปกติ';
  }
  if (warning.level === 'strong') {
    return `ใกล้ถึงช่วงปลดล็อกแล้ว เหลืออีก ${warning.remaining} ครั้งก่อนบันทึกด้วยแพ็ก 199 บาท`;
  }
  return 'ชุดนี้พร้อมบันทึกแล้ว ปลดล็อก 199 บาทเพื่อเซฟสติกเกอร์';
};

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
}: {
  avatarSrc?: string;
}) => (
  <header className="sticky top-0 z-50 flex items-center px-6 py-3 bg-surface border-b border-outline-variant/30 backdrop-blur-md">
    <div className="flex items-center gap-3 min-w-0">
      <div className="w-10 h-10 rounded-full overflow-hidden shadow-sm shrink-0">
        <img src={avatarSrc || TEMPLATE_IMAGES.AVATAR} alt="User" className="w-full h-full object-cover" />
      </div>
      <h1 className="text-xl font-extrabold text-primary tracking-tight truncate">Mia-U-Sticker</h1>
    </div>
  </header>
);

const LoadingOverlay = ({ headline, subtext, progress }: { headline: string; subtext: string; progress: number }) => (
  <div className="pointer-events-none absolute inset-0 flex items-end p-3">
    <div className="relative w-full overflow-hidden rounded-2xl bg-black/35 p-3 text-white shadow-lg backdrop-blur-[4px]">
      <motion.span
        aria-hidden="true"
        className="absolute right-5 top-3 h-2 w-2 rounded-full bg-secondary-container"
        animate={{ y: [0, -5, 0], opacity: [0.35, 1, 0.35] }}
        transition={{ duration: 1.7, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.span
        aria-hidden="true"
        className="absolute right-10 top-8 h-1.5 w-1.5 rounded-full bg-white"
        animate={{ y: [0, -4, 0], opacity: [0.25, 0.9, 0.25] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: 0.35 }}
      />

      <div className="flex items-center gap-3">
        <motion.div
          className="relative h-12 w-12 shrink-0 overflow-hidden rounded-2xl border-2 border-white/50 bg-white shadow-md"
          animate={{ rotate: [-2, 2, -2], y: [0, -2, 0] }}
          transition={{ duration: 2.1, repeat: Infinity, ease: 'easeInOut' }}
        >
          <img src={TEMPLATE_IMAGES.STICKERS[0]} alt="" className="h-full w-full object-contain p-1" />
          <span className="absolute inset-x-2 bottom-1 h-1 rounded-full bg-primary/20" />
        </motion.div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/50 border-t-white" />
            <p className="truncate text-sm font-semibold text-white">{headline}</p>
          </div>
          <p className="mt-1 truncate text-xs text-white/90">{subtext}</p>
        </div>
      </div>

      <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/25">
        <motion.span
          className="relative block h-full rounded-full bg-ai-gradient transition-all duration-500"
          style={{ width: `${progress}%` }}
        >
          <motion.span
            aria-hidden="true"
            className="absolute inset-y-0 left-0 w-10 bg-white/35 blur-sm"
            animate={{ x: ['-120%', '260%'] }}
            transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
          />
        </motion.span>
      </div>
    </div>
  </div>
);

const PromptPresetTray = ({
  prompt,
  hasGenerated,
  onPromptChip,
}: {
  prompt: string;
  hasGenerated: boolean;
  onPromptChip: (chip: string) => void;
}) => {
  const [activeGroupLabel, setActiveGroupLabel] = useState<PromptChipGroupLabel>('Scene');
  const activeGroup = PROMPT_CHIP_GROUPS.find((group) => group.label === activeGroupLabel) ?? PROMPT_CHIP_GROUPS[1];
  const selectedPromptParts = useMemo(
    () => prompt.split(',').map((part) => part.trim().toLowerCase()).filter(Boolean),
    [prompt],
  );

  return (
    <div className="mt-4 rounded-2xl border border-border-light-purple/70 bg-white/45 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-extrabold uppercase tracking-[0.16em] text-outline">Quick ideas</p>
        <div className="flex min-w-0 gap-1 overflow-x-auto rounded-full bg-surface-container p-1">
          {PROMPT_CHIP_GROUPS.map((group) => {
            const active = group.label === activeGroupLabel;
            return (
              <button
                type="button"
                key={group.label}
                onClick={() => setActiveGroupLabel(group.label)}
                className={`h-8 shrink-0 rounded-full px-3 text-[11px] font-extrabold transition-colors ${
                  active
                    ? 'bg-white text-primary shadow-sm'
                    : 'text-on-surface-variant hover:bg-white/60'
                }`}
              >
                {group.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="-mx-3 mt-3 overflow-x-auto px-3 pb-1">
        <div className="flex w-max gap-2">
          {activeGroup.chips.map((tag) => {
            const selected = selectedPromptParts.includes(tag.toLowerCase());
            return (
              <button
                type="button"
                key={tag}
                onClick={() => onPromptChip(tag)}
                disabled={selected}
                className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-xs font-bold transition-colors disabled:cursor-default ${
                  selected
                    ? 'bg-secondary-container text-on-secondary-container'
                    : 'bg-surface-container-high text-on-surface-variant hover:bg-primary-container/10'
                }`}
              >
                <SparklesIcon className="h-3.5 w-3.5" />
                {tag}
              </button>
            );
          })}
        </div>
      </div>

      {hasGenerated ? (
        <p className="mt-3 rounded-xl bg-primary/5 px-3 py-2 text-xs font-bold leading-5 text-primary">
          Tip: update details here, then regenerate only the unlocked stickers below.
        </p>
      ) : null}
    </div>
  );
};

const GeneratorView = ({
  config,
  loading,
  canGenerate,
  loadingHeadline,
  loadingSubtext,
  simulatedProgress,
  generateLabel,
  hasGenerated,
  helperText,
  onUploadClick,
  onImageUpload,
  onStyleChange,
  onPromptChange,
  onPromptChip,
  onUsePromptExample,
  onClearPrompt,
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
  hasGenerated: boolean;
  helperText?: string | null;
  onUploadClick: () => void;
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStyleChange: (style: StickerStyle) => void;
  onPromptChange: (prompt: string) => void;
  onPromptChip: (chip: string) => void;
  onUsePromptExample: () => void;
  onClearPrompt: () => void;
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
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onUsePromptExample}
            className="px-3 py-1.5 bg-primary/5 rounded-full text-[11px] font-bold text-primary hover:bg-primary/10 transition-colors"
          >
            Use example
          </button>
          <button
            type="button"
            onClick={onClearPrompt}
            disabled={!config.extraPrompt}
            className="px-3 py-1.5 bg-surface-container-high rounded-full text-[11px] font-bold text-on-surface-variant hover:bg-primary-container/10 transition-colors disabled:cursor-not-allowed disabled:opacity-40"
          >
            Clear
          </button>
        </div>
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
      <PromptPresetTray
        prompt={config.extraPrompt}
        hasGenerated={hasGenerated}
        onPromptChip={onPromptChip}
      />
    </section>

    <Button className="w-full text-lg mt-4" onClick={onGenerate} disabled={loading || !canGenerate || hasGenerated}>
      {loading ? <RefreshIcon className="animate-spin" /> : <SparklesIcon />}
      {loading ? generateLabel : hasGenerated ? 'Edit prompt, then regenerate below' : generateLabel}
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
      <h3 className="text-2xl font-extrabold mb-2">Ready to Save</h3>
      <p className="text-on-surface-variant text-sm mb-8">This pack is ready to unlock. Save your final stickers now or come back after the reset window.</p>

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

const AttemptWarningModal = ({
  warning,
  onClose,
  onUnlock,
}: {
  warning: GenerationWarning;
  onClose: () => void;
  onUnlock: () => void;
}) => {
  const isStrong = warning.level === 'strong';
  const title = isStrong ? 'เหลืออีกไม่กี่ครั้ง' : 'ใกล้พร้อมบันทึกแล้ว';
  const accent = isStrong ? 'bg-error-container text-on-error-container' : 'bg-primary-container/10 text-primary';
  const message = formatUserFacingWarning(warning);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40 backdrop-blur-sm p-6">
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 12 }}
        className="bg-white rounded-[32px] p-7 w-full max-w-sm text-center shadow-2xl"
      >
        <div className={`w-20 h-20 rounded-full flex items-center justify-center mx-auto mb-6 ${accent}`}>
          {isStrong ? <NotificationIcon className="w-9 h-9" /> : <SparklesIcon className="w-9 h-9" />}
        </div>
        <h3 className="text-2xl font-extrabold mb-3">{title}</h3>
        <p className="text-on-surface-variant text-sm leading-6 mb-5">{message}</p>

        {isStrong ? (
          <div className="mb-7 rounded-2xl border-2 border-border-light-purple bg-surface-container px-5 py-4">
            <p className="text-[10px] font-extrabold uppercase tracking-[0.18em] text-outline">Remaining</p>
            <p className="mt-1 text-3xl font-black text-primary tabular-nums">{warning.remaining}</p>
          </div>
        ) : null}

        <div className="space-y-3">
          {isStrong ? (
            <Button className="w-full" onClick={onUnlock}>
              <PayIcon />
              Unlock & Save 199 THB
            </Button>
          ) : null}
          <Button variant={isStrong ? 'secondary' : 'primary'} className="w-full" onClick={onClose}>
            เข้าใจแล้ว
          </Button>
        </div>
      </motion.div>
    </div>
  );
};

const GridView = ({
  stickerSlots,
  selectedCount,
  finalPackPaid,
  loading,
  retryBlocked,
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
  retryBlocked: boolean;
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
        const isKept = slot.locked;
        return (
          <motion.button
            type="button"
            key={slot.id}
            whileTap={{ scale: 0.95 }}
            onClick={() => onToggle(index)}
            disabled={loading || finalPackPaid}
            className={`relative aspect-square rounded-[24px] overflow-hidden transition-all duration-300 cursor-pointer disabled:cursor-not-allowed ${
              isKept
                ? 'border-ai-gradient shadow-lg scale-100'
                : 'border-2 border-primary/50 shadow-sm scale-100'
            }`}
          >
            <img
              src={slot.url}
              alt={`Sticker ${index + 1}`}
              className={`w-full h-full object-contain bg-white transition-opacity duration-300 ${isKept ? 'opacity-82' : 'opacity-100'}`}
            />
            {isKept ? (
              <div className="absolute inset-0 bg-primary/14" aria-hidden="true" />
            ) : null}
            <div className={`absolute top-2 right-2 w-8 h-8 rounded-full shadow-md flex items-center justify-center transition-all ${
              isKept ? 'bg-white text-primary' : 'bg-secondary-container text-on-secondary-container'
            }`}>
              {isKept ? <LockIcon className="w-4 h-4" /> : <RefreshIcon className="w-5 h-5" />}
            </div>
          </motion.button>
        );
      })}
    </div>

    {helperText ? <p className="mt-5 text-sm text-center text-on-surface-variant">{helperText}</p> : null}
    {error ? <p className="mt-3 rounded-2xl bg-error-container px-4 py-3 text-sm font-bold text-on-error-container">{error}</p> : null}

    <div className="mt-12 flex flex-col gap-4 sticky bottom-6">
      <Button variant="secondary" className="w-full" onClick={onRegenerate} disabled={loading || finalPackPaid || retryBlocked}>
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

const WorkspaceView = ({
  config,
  loading,
  canGenerate,
  retryBlocked,
  loadingHeadline,
  loadingSubtext,
  simulatedProgress,
  generateLabel,
  helperText,
  error,
  stickerSlots,
  selectedCount,
  finalPackPaid,
  fileInputRef,
  gridRef,
  onUploadClick,
  onImageUpload,
  onStyleChange,
  onPromptChange,
  onPromptChip,
  onUsePromptExample,
  onClearPrompt,
  onGenerate,
  onToggleSticker,
  onRegenerate,
  onContinue,
  onSelectAll,
  onClearAll,
}: {
  config: StickerSheetConfig;
  loading: boolean;
  canGenerate: boolean;
  retryBlocked: boolean;
  loadingHeadline: string;
  loadingSubtext: string;
  simulatedProgress: number;
  generateLabel: string;
  helperText?: string | null;
  error?: string | null;
  stickerSlots: StickerSlot[];
  selectedCount: number;
  finalPackPaid: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  gridRef: React.RefObject<HTMLDivElement>;
  onUploadClick: () => void;
  onImageUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onStyleChange: (style: StickerStyle) => void;
  onPromptChange: (prompt: string) => void;
  onPromptChip: (chip: string) => void;
  onUsePromptExample: () => void;
  onClearPrompt: () => void;
  onGenerate: () => void;
  onToggleSticker: (index: number) => void;
  onRegenerate: () => void;
  onContinue: () => void;
  onSelectAll: () => void;
  onClearAll: () => void;
}) => {
  const hasGrid = stickerSlots.length > 0;

  return (
    <div>
      <GeneratorView
        config={config}
        loading={loading}
        canGenerate={canGenerate}
        retryBlocked={isCapacityRetryActive}
        loadingHeadline={loadingHeadline}
        loadingSubtext={loadingSubtext}
        simulatedProgress={simulatedProgress}
        generateLabel={generateLabel}
        hasGenerated={hasGrid}
        helperText={hasGrid ? 'Keep this setup visible. Edit style or details above, then regenerate only the unselected stickers below.' : helperText || error}
        onUploadClick={onUploadClick}
        onImageUpload={onImageUpload}
        onStyleChange={onStyleChange}
        onPromptChange={onPromptChange}
        onPromptChip={onPromptChip}
        onUsePromptExample={onUsePromptExample}
        onClearPrompt={onClearPrompt}
        onGenerate={onGenerate}
        fileInputRef={fileInputRef}
      />

      <AnimatePresence initial={false}>
        {hasGrid ? (
          <motion.div
            ref={gridRef}
            initial={{ opacity: 0, y: 24 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.28, ease: 'easeOut' }}
            className="border-t border-outline-variant/30"
          >
            <GridView
              stickerSlots={stickerSlots}
              selectedCount={selectedCount}
              finalPackPaid={finalPackPaid}
              loading={loading}
              retryBlocked={retryBlocked}
              helperText={helperText}
              error={error}
              onToggle={onToggleSticker}
              onRegenerate={onRegenerate}
              onContinue={onContinue}
              onSelectAll={onSelectAll}
              onClearAll={onClearAll}
            />
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
};

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
  finalPackExported,
  extraPackPaid,
  isBusy,
  onToggleExtra,
  onSelectFirst16,
  onClearExtras,
  onPayExtra,
  onDownloadExtras,
  onDownloadFinal,
  finalDownloadLabel,
  extraDownloadLabel,
  isFinalSaving,
  onOpenStickerMaker,
}: {
  stickerSlots: StickerSlot[];
  extraSlots: ExtraSlot[];
  selectedExtraIds: string[];
  finalPackExported: boolean;
  extraPackPaid: boolean;
  isBusy: boolean;
  onToggleExtra: (id: string) => void;
  onSelectFirst16: () => void;
  onClearExtras: () => void;
  onPayExtra: () => void;
  onDownloadExtras: () => void;
  onDownloadFinal: () => void;
  finalDownloadLabel: string;
  extraDownloadLabel: string;
  isFinalSaving: boolean;
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
        <p className="text-on-surface-variant">
          {finalPackExported
            ? 'Your stickers are ready for the world.'
            : 'Your Final Pack is unlocked. Save it to your photos now.'}
        </p>
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
          <Button variant={finalPackExported ? 'secondary' : 'primary'} className="w-full h-12" onClick={onDownloadFinal} disabled={isFinalSaving}>
            {isFinalSaving ? <RefreshIcon className="animate-spin" /> : <DownloadIcon />}
            {finalDownloadLabel}
          </Button>
          <Button variant="line" className="w-full h-12 text-sm" onClick={onOpenStickerMaker}><LineIcon /> Open LINE Sticker Maker</Button>
        </div>
      </div>

      {!finalPackExported ? (
        <section className="rounded-[32px] border-2 border-border-light-purple bg-surface-container p-6 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-primary-fixed text-primary">
            <LockIcon className="h-7 w-7" />
          </div>
          <h3 className="mb-2 text-lg font-extrabold text-on-surface">Extra Vault is next</h3>
          <p className="text-sm leading-6 text-on-surface-variant">
            Save your Final Pack first, then your extra regenerated stickers will appear here.
          </p>
        </section>
      ) : extraSlots.length ? (
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

      {finalPackExported && extraSlots.length ? (
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
              {isBusy ? <RefreshIcon className="animate-spin" /> : extraPackPaid ? <DownloadIcon /> : <PaymentsIcon />}
              {extraPackPaid ? extraDownloadLabel : 'Payment 99 THB'}
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

const DoneView = ({
  finalCount,
  extraCount,
  isBusy,
  onCreateNewPack,
  onOpenStickerMaker,
}: {
  finalCount: number;
  extraCount: number;
  isBusy: boolean;
  onCreateNewPack: () => void;
  onOpenStickerMaker: () => void;
}) => (
  <div className="flex min-h-screen flex-col gap-8 p-6">
    <section className="mt-8 text-center">
      <div className="relative mx-auto mb-8 flex h-36 w-36 items-center justify-center rounded-full bg-success-teal/10 shadow-inner">
        <img src={TEMPLATE_IMAGES.CELEBRATION} alt="All done" className="h-28 w-28 rounded-full object-cover shadow-lg" />
        <div className="absolute -right-1 bottom-2 flex h-12 w-12 items-center justify-center rounded-full bg-success-teal text-white shadow-lg">
          <CheckIcon className="h-7 w-7" />
        </div>
      </div>
      <h2 className="mb-2 text-3xl font-extrabold text-primary">All Set!</h2>
      <p className="text-sm leading-6 text-on-surface-variant">
        Your Final Pack and Extra Vault are saved. Start a fresh sticker pack whenever you are ready.
      </p>
    </section>

    <section className="rounded-[32px] border-2 border-border-light-purple bg-white p-6 shadow-sm">
      <div className="space-y-4">
        {[
          { label: 'Final Pack saved', value: `${finalCount || DEFAULT_STICKER_COUNT} stickers` },
          { label: 'Extra Vault saved', value: `${extraCount} extras` },
          { label: 'Next pack', value: 'Ready for a fresh set' },
        ].map((item) => (
          <div key={item.label} className="flex items-center justify-between gap-4 rounded-2xl bg-surface-container px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-fixed text-primary">
                <CheckIcon className="h-4 w-4" />
              </span>
              <p className="font-bold text-on-surface">{item.label}</p>
            </div>
            <p className="text-right text-xs font-bold text-on-surface-variant">{item.value}</p>
          </div>
        ))}
      </div>
    </section>

    <div className="mt-auto flex flex-col gap-3 pb-8">
      <Button className="w-full py-6 text-lg" onClick={onCreateNewPack} disabled={isBusy}>
        {isBusy ? <RefreshIcon className="animate-spin" /> : <SparklesIcon />}
        {isBusy ? 'Starting...' : 'Create New Pack'}
      </Button>
      <Button variant="line" className="w-full h-12 text-sm" onClick={onOpenStickerMaker} disabled={isBusy}>
        <LineIcon />
        Open LINE Sticker Maker
      </Button>
    </div>
  </div>
);

const GeneratePage: React.FC = () => {
  const isOnline = useOnlineStatus();
  const { profile } = useAuth();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

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
  const [isResettingPack, setIsResettingPack] = useState(false);
  const [dismissedLimit, setDismissedLimit] = useState(false);
  const [warningPopup, setWarningPopup] = useState<GenerationWarning | null>(null);
  const [clockTick, setClockTick] = useState(0);
  const [capacityRetryUntil, setCapacityRetryUntil] = useState<number | null>(null);
  const [capacityRetryTick, setCapacityRetryTick] = useState(0);

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
    if (!capacityRetryUntil) return;
    const timer = window.setInterval(() => {
      if (Date.now() >= capacityRetryUntil) {
        setCapacityRetryUntil(null);
        setError((previous) => (previous === AI_CAPACITY_ERROR_MESSAGE ? null : previous));
      }
      setCapacityRetryTick((tick) => tick + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [capacityRetryUntil]);

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

  const finalPackPaid = Boolean(generationState?.final_pack_paid);
  const finalPackExported = Boolean(generationState?.final_pack_exported);
  const extraPackPaid = Boolean(generationState?.extra_pack_paid);
  const extraPackExported = Boolean(generationState?.extra_pack_exported);
  const isGenerationLocked = Boolean(generationState?.is_generation_locked);
  const cooldownLabel = useMemo(
    () => formatCountdown(generationState?.generation_cooldown_until),
    [clockTick, generationState?.generation_cooldown_until],
  );
  const retryClockNow = Date.now() + capacityRetryTick * 0;
  const capacityRetryRemainingSeconds = capacityRetryUntil
    ? Math.max(0, Math.ceil((capacityRetryUntil - retryClockNow) / 1000))
    : 0;
  const isCapacityRetryActive = capacityRetryRemainingSeconds > 0;
  const capacityRetryMessage = isCapacityRetryActive
    ? `${AI_CAPACITY_ERROR_MESSAGE} (${formatRetryCountdown(capacityRetryRemainingSeconds)})`
    : null;
  const lockedCount = stickerSlots.filter((slot) => slot.locked).length;
  const unlockedCount = stickerSlots.length ? stickerSlots.length - lockedCount : DEFAULT_STICKER_COUNT;
  const canGenerate = Boolean(config.base64Image) && !isGenerationLocked && !isCapacityRetryActive && !(finalPackPaid && !finalPackExported);

  const loadingHeadline =
    processingStep === 'analyzing'
      ? 'Reading selfie magic'
      : processingStep === 'generating'
        ? `Drawing tiny mood ${simulatedStickerCount}/${generationTargetCount}`
        : processingStep === 'removing'
          ? 'Polishing transparent PNGs'
          : 'Ready';

  const loadingSubtext =
    processingStep === 'analyzing'
      ? 'Finding the cutest angles'
      : processingStep === 'generating'
        ? 'Cooking expressive sticker poses'
        : processingStep === 'removing'
          ? 'Packing everything for LINE-ready save'
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

  const displayError = capacityRetryMessage || error;

  const helperText = formatUserFacingWarning(generationState?.warning)
    || (isGenerationLocked ? `Reset in ${cooldownLabel ?? '24h'} or unlock the final pack.` : null);

  const currentView: 'workspace' | 'checkout' | 'success' | 'done' = checkoutProduct
    ? 'checkout'
    : finalPackExported && extraPackExported
      ? 'done'
      : finalPackPaid
      ? 'success'
      : 'workspace';

  const activeCheckoutProduct = checkoutProduct;

  const openImagePicker = () => fileInputRef.current?.click();

  const appendPromptChip = (chip: string) => {
    setConfig((previous) => {
      const parts = previous.extraPrompt
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
      const alreadyExists = parts.some((part) => part.toLowerCase() === chip.toLowerCase());
      if (alreadyExists) return previous;
      return {
        ...previous,
        extraPrompt: [...parts, chip].join(', '),
      };
    });
    setError(null);
  };

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
      setWarningPopup(null);
      setError(null);
      setCapacityRetryUntil(null);
      if (profile?.userId) {
        resetCurrentStickers(profile.userId).catch(() => null);
      }
    };
    reader.readAsDataURL(file);
  };

  const applyCapacityRetry = (retryAfterSeconds?: number | null) => {
    const retrySeconds = Math.max(30, Number(retryAfterSeconds || 300));
    setCapacityRetryUntil(Date.now() + retrySeconds * 1000);
    setCapacityRetryTick((tick) => tick + 1);
    setError(AI_CAPACITY_ERROR_MESSAGE);
  };

  const extractBackendDetail = (err: any) => err?.backendDetail || err?.response?.data?.detail;

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
    if (isCapacityRetryActive) {
      setError(AI_CAPACITY_ERROR_MESSAGE);
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
    setWarningPopup(null);

    const pollUntilComplete = async (jobId: string) => {
      const maxAttempts = 180;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const statusResp = await checkJobStatus(jobId);
        if (statusResp.status === 'completed' && statusResp.result_slots) {
          if (statusResp.generation_state) setGenerationState(statusResp.generation_state);
          return statusResp;
        }
        if (statusResp.status === 'failed') {
          const failure = new Error(statusResp.error || 'Generation failed.');
          (failure as any).backendDetail = statusResp;
          throw failure;
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
      setCapacityRetryUntil(null);
      const nextWarning = currentData.generation_state?.warning;
      if (nextWarning && nextWarning.level !== 'limit_reached') {
        setWarningPopup(nextWarning);
      }
      setProcessingStep('complete');
      window.setTimeout(() => {
        const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        gridRef.current?.scrollIntoView({
          behavior: prefersReducedMotion ? 'auto' : 'smooth',
          block: 'start',
        });
      }, 250);
    } catch (err: any) {
      const backendDetail = extractBackendDetail(err);
      if (backendDetail?.generation_state) {
        setGenerationState(backendDetail.generation_state);
      }
      if (backendDetail?.generation_state?.is_generation_locked) {
        setDismissedLimit(false);
      }
      if (backendDetail?.error_code === AI_CAPACITY_ERROR_CODE) {
        applyCapacityRetry(backendDetail.retry_after_seconds);
        return;
      }
      const message = backendDetail?.generation_state?.warning?.message
        || (backendDetail?.error_code === 'generation_limit_reached'
          ? 'Limit reached. Unlock 199 THB to save this sticker pack.'
          : typeof backendDetail === 'string'
            ? backendDetail
            : backendDetail?.message || err?.message || 'Error connecting to server.');
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

  const saveFinalPackToDevice = async (finalizeAfterSave: boolean) => {
    if (!profile?.userId) return;

    if (isAndroidDevice() && isInLiffClient()) {
      window.location.assign(buildExternalBrowserSaveToPhotosUrl());
      return;
    }

    if (canUseNativeFileShare()) {
      try {
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
          if (finalizeAfterSave) await finalizeFinalPackExport();
          return;
        }
      } catch (shareError) {
        console.warn('Native file share failed; falling back to ZIP download.', shareError);
        setError('Native save was unavailable, downloading ZIP instead.');
      }
    }

    const { url } = await getCurrentStickersDownloadUrl(profile.userId);
    openDownloadUrl(url);
    if (finalizeAfterSave) await finalizeFinalPackExport();
  };

  const handleSaveFinalPack = async () => {
    if (!profile?.userId) return;
    if (!finalPackPaid) {
      setCheckoutProduct('final_pack_199');
      return;
    }

    try {
      setIsSavingFinal(true);
      setError(null);
      await saveFinalPackToDevice(true);
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
      setIsSavingFinal(true);
      setError(null);
      await saveFinalPackToDevice(false);
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Could not download final pack.');
    } finally {
      setIsSavingFinal(false);
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

  const saveExtraVaultToDevice = async (idsToExport: string[]) => {
    if (!profile?.userId) return;

    if (canUseNativeFileShare()) {
      try {
        const batchId = buildSaveToPhotosBatchId();
        const files = await Promise.all(
          idsToExport.map(async (extraId, index) => {
            const blob = await downloadExtraVaultStickerForShare(profile.userId, extraId);
            return new File([blob], buildExtraPngFileName(index, batchId), { type: 'image/png' });
          }),
        );
        const canShare = typeof navigator.canShare === 'function' ? navigator.canShare({ files }) : true;
        if (canShare) {
          await navigator.share({ files, title: 'Mia-U-Sticker Extra Vault' });
          const finalized = await finalizeExtraVaultExport(profile.userId);
          setGenerationState(finalized.generation_state);
          return;
        }
      } catch (shareError) {
        console.warn('Native extra file share failed; falling back to ZIP download.', shareError);
        setError('Native save was unavailable, downloading ZIP instead.');
      }
    }

    const { url, generation_state } = await getExtraVaultDownloadUrl(profile.userId, idsToExport);
    setGenerationState(generation_state);
    openDownloadUrl(url);
    const finalized = await finalizeExtraVaultExport(profile.userId);
    setGenerationState(finalized.generation_state);
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
      setError(null);
      await saveExtraVaultToDevice(idsToExport);
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

  const handleCreateNewPack = async () => {
    if (!profile?.userId) return;
    try {
      setIsResettingPack(true);
      setError(null);
      await resetCurrentStickers(profile.userId);
      setConfig({
        base64Image: '',
        size: '2K',
        aspectRatio: '1:1',
        extraPrompt: '',
        style: 'Pixar 3D',
      });
      setStickerSlots([]);
      setExtraSlots([]);
      setSelectedExtraIds([]);
      setGenerationState(null);
      setCheckoutProduct(null);
      setGenerationTargetCount(DEFAULT_STICKER_COUNT);
      setProcessingStep('idle');
      setDismissedLimit(false);
      setWarningPopup(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err: any) {
      setError(err?.response?.data?.detail || err?.message || 'Could not start a new pack.');
    } finally {
      setIsResettingPack(false);
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

    if (currentView === 'done') {
      return (
        <DoneView
          finalCount={stickerSlots.length || DEFAULT_STICKER_COUNT}
          extraCount={generationState?.extra_pack_selected_ids?.length || extraSlots.length}
          isBusy={isResettingPack}
          onCreateNewPack={handleCreateNewPack}
          onOpenStickerMaker={handleOpenStickerMaker}
        />
      );
    }

    if (currentView === 'success') {
      return (
        <SuccessView
          stickerSlots={stickerSlots}
          extraSlots={extraSlots}
          selectedExtraIds={selectedExtraIds}
          finalPackExported={finalPackExported}
          extraPackPaid={extraPackPaid}
          isBusy={isCreatingPayment === 'extra_pack_99' || isExtraExporting}
          onToggleExtra={toggleExtraSelection}
          onSelectFirst16={() => setSelectedExtraIds(extraSlots.slice(0, 16).map((slot) => slot.id))}
          onClearExtras={() => setSelectedExtraIds([])}
          onPayExtra={handleBuyExtraPack}
          onDownloadExtras={handleDownloadExtras}
          onDownloadFinal={finalPackExported ? handleDownloadFinalAgain : handleSaveFinalPack}
          finalDownloadLabel={finalPackExported ? (isMobileDevice() ? 'Save to Photos' : 'Download ZIP') : 'Save to Photos'}
          extraDownloadLabel={isMobileDevice() ? 'Save to Photos' : 'Download ZIP'}
          isFinalSaving={isSavingFinal}
          onOpenStickerMaker={handleOpenStickerMaker}
        />
      );
    }

    return (
      <WorkspaceView
        config={config}
        loading={loading}
        canGenerate={canGenerate}
        loadingHeadline={loadingHeadline}
        loadingSubtext={loadingSubtext}
        simulatedProgress={simulatedProgress}
        generateLabel={loading ? loadingHeadline : 'Generate'}
        helperText={helperText}
        error={displayError}
        stickerSlots={stickerSlots}
        selectedCount={lockedCount}
        finalPackPaid={finalPackPaid}
        gridRef={gridRef}
        onUploadClick={openImagePicker}
        onImageUpload={handleImageUpload}
        onStyleChange={(style) => setConfig((previous) => ({ ...previous, style }))}
        onPromptChange={(prompt) => setConfig((previous) => ({ ...previous, extraPrompt: prompt }))}
        onPromptChip={(chip) => appendPromptChip(chip)}
        onUsePromptExample={() => setConfig((previous) => ({ ...previous, extraPrompt: PROMPT_GUIDE_EXAMPLE }))}
        onClearPrompt={() => setConfig((previous) => ({ ...previous, extraPrompt: '' }))}
        onGenerate={generateSheet}
        onToggleSticker={toggleStickerLock}
        onRegenerate={generateSheet}
        onContinue={() => setCheckoutProduct('final_pack_199')}
        onSelectAll={() => setStickerSlots((previous) => previous.map((slot) => ({ ...slot, locked: true })))}
        onClearAll={() => setStickerSlots((previous) => previous.map((slot) => ({ ...slot, locked: false })))}
        fileInputRef={fileInputRef}
      />
    );
  };

  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      {currentView !== 'checkout' ? (
        <Header
          avatarSrc={profile?.pictureUrl}
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

      <AnimatePresence>
        {currentView === 'workspace' && !isGenerationLocked && warningPopup ? (
          <AttemptWarningModal
            warning={warningPopup}
            onClose={() => setWarningPopup(null)}
            onUnlock={() => {
              setWarningPopup(null);
              setCheckoutProduct('final_pack_199');
            }}
          />
        ) : null}
      </AnimatePresence>
    </div>
  );
};

export default GeneratePage;
