/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  CircleDollarSign as TokenIcon, 
  MessageCircle as LineIcon, 
  Upload as UploadIcon, 
  Sparkles as SparklesIcon,
  RotateCcw as RefreshIcon,
  CheckCircle2 as CheckIcon,
  Lock as LockIcon,
  Bell as NotificationIcon,
  ArrowLeft as BackIcon,
  X as CloseIcon,
  Download as DownloadIcon,
  ShoppingCart as PayIcon,
  Heart as HeartIcon,
  Monitor as HighQualityIcon,
  Unlock as UnlockIcon,
  Bot as RobotIcon,
  CreditCard as PaymentsIcon,
  Star as StarIcon
} from 'lucide-react';

// --- Types & Constants ---

enum View {
  LOGIN,
  GENERATOR,
  GRID,
  CHECKOUT,
  SUCCESS
}

const IMAGES = {
  MASCOT_LOGIN: "https://lh3.googleusercontent.com/aida-public/AB6AXuAkK5PgG-NE0klet0BhGI4icp6iHJTS0M8f5AEyW-BwFH-izSMhiTDxJVvd8qV-64C1li6wjO9756srgNkBOVmpmOzQMD4P-sNMLc1JLX8SnPwMCUgsFsqPrrvOdZ2kznH_u2QbN0lpJvIZfOAUBi0UWsRzHHleah45VYM5KteEU6qe6157TAaW3Y66F_pRtluqS_6NP9b8mCoW5pwpcQcyvBngctJTlEpVpr9PvQHbylKRbrMWkx8rltFUepC_6yoehzdzhga-mS39",
  STICKER_PACK: "https://lh3.googleusercontent.com/aida-public/AB6AXuA2qJ4-KPnQZp4tLFOsYwvSsATWW2_2NE7D4dBvE1Gys-SR8w_5ZhoANpgk3AfoGiT2iLXBvmWVip_IgLWrl7lHHcvNs7hvrCNx2C2vOcMa74hfWsr4Af5irRnU5zLj7-9Pjn_RZz40b8kIiUiukfB1YkTbxY7hwbfziJuWI9NeTlctvz3DEdvDHLuduI7aFGL_PudP13UTIZR7Iyc4fvfbw46KRx59hRXHPYrBav6WjX2w6PQ2OWoNPMIuPDbdQF-4wR29jwnFk4da",
  CELEBRATION: "https://lh3.googleusercontent.com/aida-public/AB6AXuBrM2znrzjsJ9nwIOrhW-KkU4Jk4BHSBAJZZOyB_AsxYYEJ09FZ_6Riac7ybuoSme2_qhOWZjvSB_WTnRW15TVUr_nQl4lsTtaNsy3vbY7NjpDF39vyGG7kLXRnq1vxDNdv91iDtaot1WvPnAsv90SkYGPIgmwHpI5u-nQsAksCcxZ7LjrbbJ6qgehGy4SWd5GrnWyzLPmRJzHGJsYnIFKXwuUM2gmd3Nnojb0lSVSlHgJFvStiftQqQj03MGUUbemBAceSCkAAuP1c",
  AVATAR: "https://lh3.googleusercontent.com/aida-public/AB6AXuDa4IDlYQ-k6X5oTex6PbcDi-UCRrbqOE2glwTQGNp0mZARCPHrUAp6LQ_eNjKGMsf9Vkz7DPDaLVBbIFwFEYLyDm2W_I4PJvFDxFZQjjvVmXYN9qsA8eQx7QOa57kkqISn0D0_ZLVGe9oi4eRUoNnQbgk3_kcKlgbbiQCEqv8EnuwpmnjqWZcsQpykzNYjYeDfkmxjXOH4FxujyJOitg7sSIyOXY8779Y_H-NVoAfvZG4C7r_UoScwe18OMzh50dW5fICIeWDlydEa",
  STICKERS: [
    "https://lh3.googleusercontent.com/aida-public/AB6AXuAiFkYbKEoCLxUJYQVFGtuhtimRX7z_jB-mGhwi5-ym7SX3Fk6GN2z-T1mlKr2pUJAadRIW7ciO5ul3StC2kY7VQz8YACjg1y-iimifIWDUH7wRlXReAU6jCIb6R0Eji_1_DjvMHTVY-uMxs9Zau3Sdk9uY9_TulhuftxblEntZdjbn0ZhYOFqlwSDpIfNH9pbMxk7SxTgK-HfI-p_bIQYdJTlnRy9doMHyRFwjxM4IxW1Axb0d7nDYdEydgLspyKWcTo061sE8knZj",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuBwCtgCKXtj9Vcmc_AbFdVIQi8vjHcUW65VowZnbSFr9H1_6c-aoF2gnPI84FTLZagkTaAu4iAJkOwXrOMw4PANTGjvOgQYQvWIhKtz-Zt5HJcv3ZJbp_ZTZmMtu32OUFShw0ICRwXDIupHCPZNkEPyiBhYfn6ZhzEI7E2fhC-UwBDXliu-9fSNVi97k9_76IZtonFLA6VPofTWqrvVTZfxx_o9HLrcSRVUKwuKVg72UM7YLY6M22dUy81YD1IsXrvDpTSCYPZyReOc",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDos9S2VE_aAIFUnColkFXzVImci1kYR4ukzjO-5ubtJcYzeTA86LT4LS0uHkgPF60ljUsBqVLuJjSBO4zdwK4gpL_lOZFWDSYhJKd3wTeOxpCbZRiN3VLsZ74IiWk-CRa1_2bJeUSeOYi0SnxPS8SrwqtayQ7nLfeJsNkU049BkApWP5hsTw3oGa5ctWTkHOYaIpjuOkQxcFZjh12L6iNAbk1-qJD7ci86pDH-LzbD5St8d3OBPBVs0vCXpG0J6-uE6YlfGjti9EJF",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuD_o8Lq2_PNsNZZUcVwySX6icC9grJQzqAfHRI_7ELKQsgSUEQ_8_eDZ5-xz8ERHzZ15XwHcrC9PeoJvZ0PTs8X_Z42H53oHNfCJFYgWdpRrZJqIOBUs81cC1-EXxk2OtjxzRI3VoBnVp2FpAvuLzXPLZ1u_rk_OBvuk0l2I97zcXeI27_X8dA8TR7CKNZWYIb4M1d5eQMf6qNkvpPdPnkcHwd9Jw_SrS0O4rgEiw2sB782uYasfFhvoEbQGbagHNGu6vjcwi8Y6mT8",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDx2PzSvmduh3eNHsdZU4L7ewt-eMjz_L4tJ-WfeKvK0F0seADPEZsvW5eKonkGFVM6Z6uy_PeycpasTH91Ps9atIzsfJRV0PoT92suM1BwbqgIuuTrH5pPjqht59rBh2rm3PwmVDDPq2zmaRjzuAmccEEqMkOrBtu6NQV8ojNnDsuZVAbf8XTb03vX1Vd2CZErXvPQAk1I1Qb1jhmeUS38Y49fjSMp0ZliwFF4-4YwdU-18d7wHiT2_RK2E5izBSn78VNHATf-0rmE",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDDfXxWzPRFkrCACmpDTGKC7PbVWQeD7ijTjy0KQI0k589_y8ULu0RH5z1moqYUgUpAPu9bVir02e1aBTjZQBdguZx00K-JFfFzqxCrjIop7q13ytVNAYtyKtFYPpciVHHKw8L7wgd64hqk-GlQ4GOrnD-7VIg4cfssaWnOutc28zKJ-b8J9p5eoeb8MydV8H3je6RnNUKvCW5CuSeoVhyv2mnpje3AI5AZHBRzh_NeXjLKKZMu3kSo8G2DikWI2kbSygY1po39z9JQ",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDYXGm6jalW9Eu6HVvI1jkbJy5cm-K9g6wgK2pqB2IxFthgEooWDJ-MZLo1m10GIOKQi9hFdWxEVfflk7_eY7HxInwj9rySN_7KmdIvzBJ8G6tUAVLRzXxJZMc8l_kgJ9UonQGKuX1HwnDk5mC4FsuVfNVvv6uJAHj123v6ACGhxZGG_nzoZky7zLTYDhxxKHw9F4dJhjdRoDYTG2ph-REc7GatFRweucWBluDoILFnUjgXUxx5N_vQh2OF_DRmokGP53-HvhasaE8m",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCyjF2bluBgEcvWNlISS6i4Qi_5hJIhpVvTckxL1RFhS8S3WxRMdNNsi0sOwgfT8NepR6_CqS35FtEPR_C_qV6qDLyjk3vtdlbWuTeGERHDpcXZ4Aj1yg4cgRmRrgcgF5Yy9sXv-4--Q1kPD-TxBlmEAdtl-6lAra6EEUnOLTZXIk4tdtoJQogFqzFwfHexe-tpaaMBDiYGRbQk6eMY8NqDDMMtPxHnsbQqaCUbjlBHOv13QN9GGzIJY1LSvJLUSzfjsW3mijhn0NDs",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuCALZMEOqJYr_Fa8nBAL6J12hGI6OuA4QVTdQ6blrcjmuBYcKW4DvrnB6jYyLU8faSpttxLezsLLyHCsBtu18uXNZGMcq3KKAcV-hWz9rd17bfGgZiUJ2_lgtvOPEzlyPVjGtKr2BvVbFNKyuPP1QivmSi6mmXoEnQAG9j08PUSr6Em3MbJw0eh52eT_D_AAj_UH6IkOa_0d1B0mzVn2Gp4xAGkTN2gf7Yh1zhd6qQJqZyQRPhw2dCic5qQ7G_2IXdOphurT-rjDHeq",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuC8AHKy2wrIgtGP_MqU2jR_9rUtWr564_QbtRzkMo1qHbGsnE_pnhQd2Yp_LBQ8gJ6SEbfOYtjsqEVL4_ndKWjHbFrxi2FqUCDx30GaiB1_Y0yZ5wMKoHs0TM5s5jZ2XOCSOEVzghyVV28mZu8fwGsRnXiTENGEB0Ei7X4y9FtCKelHzDwrETmkHJDjSS8qCsm3m0VPcQ4m6TjOpOvmrDSDY1_i8bZH1Q24S3w1090sJPuqQta878utmz4HJVZ7I17-8ugEGPBMr0AS",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuB-hbYtFPGSLpO6WhW1yXzOFSFvdKvA24Nnau2teHtqbmnknLlQnsoXqt-Bz63qecXaApz_2vU7HoR7uzM6zEG43O3rFEu6GwAw0vhDBrL-45WXNgV696Rl54TCJeXucDKhLBuc72WFQnbJEe7VZJSgg7_iSDtlg70gp9Y7BUh4X_dngsNXHBHnyGyx0jOiDVWi5MPr8v2d_PxOKRr0_SfbyJOH-iUPr-EdOCzTj9I8K3X0HIhgHku1WdZykDUmdQPtf0h0-43xeiYe",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuBKXoTYGSC3GaQYiisXNxWqSw8Ll01nz_AnG7RgjjOtRN9PYMdj0Mou8Toh62gP9P7dPiMxsrm75KEQMy3eUGkELiJpqkhX8B1LLJPYkoIlei_sH_acO1DymJkhQCnHw8BsDy-f8-NdHjuZPLzPwpPbf62wKxqOy8r4ZJPMu_G_kjWdwpN0Z35DM-f0n42vF2D2qzbiEvaQu15YErGOXSnFKx2QDa2-m_eyheQREmK5NlaQyj2q5IwhE9g-xaLVx-w4DgCIW57o2UR2",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDhVKMAt7FPwzWP3ZkJB0O24_hIsAv343Oy5TEvsuth1OAS0JLys9pMzZ6Mebf8g9PiavwIYm5KgRxzksOL0R5xbBjmw3pW0xySxQ9PKTvFNLNJ-jFIXomSg6re-yEU26PS48S9B9L2jxJv8sfk0c5PDKK0IDl_tP5h5vBCuv_DXGcHcA26PsSb1VdmmGkPRSqfQbsNOBpW3hWibJ016Ht_hbkINtsWtL_N7r7RSPqz8wICTo01CrG7XtqaakO2J-Md3zbVC7WxYrvB",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuC7vHjHWDnKc9UR85ZoEL6HsurFLXprznoq_4XEN9gEah6gsv_13b6vBTSk8v-fZmfOvkKhsYrD0wep_e9fuYAO-VAOyD88yZVorX2ZUOatn0JVYVT7II0lKtaNpB6ycYHZcDrMUMBqygMn3ku9P2gIps3C4KRZDx_81REmGBWxho97R5jg8Dl-8DLqm3-dfSUme7uYsm_Ul6Ja6Mo5Z1aELfwn1EX4COYnODilqZc-Ziykk5yfHjkRxKBbGMrsfM-L2QlA4F9Liyne",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDBzD4mPS9unO03-ADhkXCv7rnSdCAVk8kyivA2_soyP33nuNPcOUWBEs42A-xnwscku0AQB-654W365_1giR4kvDqBe4kbIx6IOsYZtVdOZLc19rtsM0obNESWNZqmMRY79Gx1bEM5n0cfgnBFikuI6SMlr4IAfoHzMbqUA2yOuAJKpNCXClSQVRzHjP3NCUYxd6e0LbsVswdoxnNxsZ7nqqxYHWSAJ3cHyARMS5cGE7sjpjD1421oD8iuwSmkPvi34AjIom5ijV1P",
    "https://lh3.googleusercontent.com/aida-public/AB6AXuDJvYglVVJBJKOTFK1ZoqFazAlyQy4_7l1qghTCYmfooto6pG6Z8U6MuDYNo79_844HemC7etmN496APLM9HEoSWbSUK2b3Ir6bT_zpinB4ytWxeguFd8xxnbKlHifCdgoOXOq_ym89imP8phGCWbxjPNQ4ZIxHDopt-KEcmaOkylTEoEScJW1hDD23J5L5VixV8dACznJLkBLkL4z9LkX_PcVEqULqLmS8RU78pa2-g7_IinpqkvbwZM6sadKhaOUgVc4RGzaOW_j7"
  ]
};

// --- Shared Components ---

const Header = ({ coins = 12, onNotify }: { coins?: number; onNotify?: () => void }) => (
  <header className="sticky top-0 z-50 flex items-center justify-between px-6 py-3 bg-surface border-b border-outline-variant/30 backdrop-blur-md">
    <div className="flex items-center gap-3">
      <div className="w-10 h-10 rounded-full overflow-hidden shadow-sm">
        <img src={IMAGES.AVATAR} alt="User" className="w-full h-full object-cover" />
      </div>
      <h1 className="text-xl font-extrabold text-primary tracking-tight">Manee-son AI</h1>
    </div>
    <div className="flex items-center gap-3">
      <div className="flex items-center gap-1.5 px-3 py-1.5 bg-secondary-container rounded-full shadow-sm">
        <TokenIcon className="text-on-secondary-container w-5 h-5" />
        <span className="text-sm font-bold text-on-secondary-container">{coins}</span>
      </div>
      {onNotify && (
        <button onClick={onNotify} className="relative p-2 rounded-full hover:bg-surface-container transition-colors">
          <NotificationIcon className="text-primary w-6 h-6" />
          <span className="absolute top-1 right-1 w-4 h-4 bg-error text-on-error text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-surface">12</span>
        </button>
      )}
    </div>
  </header>
);

const Button = ({ children, variant = 'primary', className = '', ...props }: any) => {
  const base = "h-[52px] px-8 rounded-full font-bold flex items-center justify-center gap-2 transition-all active:scale-95 duration-200";
  const variants: any = {
    primary: "bg-ai-gradient text-white shadow-[0_4px_12px_rgba(124,58,237,0.3)] hover:opacity-90",
    secondary: "bg-surface-container text-on-surface border-2 border-border-light-purple hover:bg-surface-container-high",
    outline: "border-2 border-primary text-primary hover:bg-primary/5",
    ghost: "text-on-surface-variant hover:bg-surface-container",
    line: "bg-[#06C755] text-white hover:opacity-90"
  };

  return (
    <button className={`${base} ${variants[variant]} ${className}`} {...props}>
      {children}
    </button>
  );
};

// --- Views ---

const LoginView = ({ onStart }: { onStart: () => void }) => (
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
      <p className="font-bold text-on-surface text-left leading-tight">Welcome Gift!<br /><span className="text-sm font-medium text-on-surface-variant">Available for you</span></p>
    </motion.div>

    <div className="w-full max-w-[280px] aspect-square rounded-[32px] bg-surface-container border-4 border-border-light-purple overflow-hidden shadow-xl mb-10 relative">
      <img src={IMAGES.MASCOT_LOGIN} alt="Mascot" className="w-full h-full object-cover" />
    </div>

    <h2 className="text-3xl font-extrabold text-primary mb-2">Manee-son AI</h2>
    <p className="text-on-surface-variant mb-12">Your Creative Playmate</p>

    <Button variant="primary" className="w-full max-w-sm" onClick={onStart}>
      <LineIcon />
      Log in with LINE
    </Button>
    <p className="mt-6 text-xs text-outline">By logging in, you agree to our Terms of Service</p>
  </div>
);

const GeneratorView = ({ onGenerate }: { onGenerate: () => void }) => {
  const [style, setStyle] = useState('3D');
  return (
    <div className="flex flex-col gap-8 p-6">
      <section>
        <h3 className="text-lg font-bold mb-4">Base Image</h3>
        <div className="border-2 border-dashed border-outline-variant rounded-2xl aspect-video flex flex-col items-center justify-center bg-surface-container-low cursor-pointer hover:bg-surface-container transition-colors">
          <div className="p-4 bg-primary-container/10 rounded-full mb-3">
            <UploadIcon className="text-primary" />
          </div>
          <p className="font-bold text-on-surface">Upload Selfie</p>
          <p className="text-xs text-on-surface-variant">JPEG, PNG up to 5MB</p>
        </div>
      </section>

      <section>
        <h3 className="text-lg font-bold mb-4">Choose Style</h3>
        <div className="grid grid-cols-2 gap-4">
          {[
            { id: '3D', label: '3D Render', img: IMAGES.STICKERS[0] },
            { id: '2D', label: '2D Anime', img: IMAGES.STICKERS[5] }
          ].map(s => (
            <div 
              key={s.id}
              onClick={() => setStyle(s.id)}
              className={`relative cursor-pointer rounded-2xl overflow-hidden transition-all duration-300 ${style === s.id ? 'ring-4 ring-primary ring-offset-2' : ''}`}
            >
              <img src={s.img} alt={s.label} className="w-full aspect-square object-cover" />
              <div className="absolute bottom-0 left-0 right-0 bg-black/40 backdrop-blur-sm p-2">
                <p className="text-white text-xs font-bold text-center">{s.label}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="text-lg font-bold mb-4">Describe Details</h3>
        <div className="bg-surface-container rounded-2xl p-4 border-2 border-border-light-purple min-h-[100px]">
          <textarea 
            placeholder="e.g. wearing a spacesuit, floating in a neon galaxy..."
            className="w-full bg-transparent border-none focus:ring-0 text-sm resize-none"
            rows={3}
          />
        </div>
        <div className="flex flex-wrap gap-2 mt-4">
          {['Cyberpunk City', 'Fairy Forest', 'Rock Star'].map(tag => (
            <span key={tag} className="px-4 py-1.5 bg-surface-container-high rounded-full text-xs font-bold text-on-surface-variant cursor-pointer hover:bg-primary-container/10 transition-colors">
              ✨ {tag}
            </span>
          ))}
        </div>
      </section>

      <Button className="w-full text-lg mt-4" onClick={onGenerate}>
        Generate
      </Button>
    </div>
  );
};

const GridView = ({ onContinue }: { onContinue: () => void }) => {
  const [selected, setSelected] = useState<number[]>([0, 3, 6, 9]);
  const [showLimit, setShowLimit] = useState(false);

  const toggleSelect = (i: number) => {
    if (selected.includes(i)) {
      setSelected(selected.filter(id => id !== i));
    } else {
      setSelected([...selected, i]);
    }
  };

  return (
    <div className="p-6">
      <div className="text-center mb-8">
        <h2 className="text-2xl font-extrabold mb-1">The Magic Grid</h2>
        <p className="text-on-surface-variant text-sm">Tap the stickers you want to keep. They are so bouncy!</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {IMAGES.STICKERS.map((src, i) => {
          const isSelected = selected.includes(i);
          return (
            <motion.div
              key={i}
              whileTap={{ scale: 0.95 }}
              onClick={() => toggleSelect(i)}
              className={`relative aspect-square rounded-[24px] overflow-hidden transition-all duration-300 cursor-pointer ${isSelected ? 'border-ai-gradient shadow-lg scale-100' : 'border-2 border-border-light-purple opacity-60 grayscale-[40%] scale-[0.98]'}`}
            >
              <img src={src} alt="Sticker" className={`w-full h-full object-cover ${!isSelected && 'blur-[1px]'}`} />
              <div className={`absolute top-2 right-2 w-8 h-8 rounded-full shadow-md flex items-center justify-center transition-all ${isSelected ? 'bg-white' : 'bg-white/40'}`}>
                {isSelected ? <CheckIcon className="text-secondary-container w-6 h-6" /> : <LockIcon className="text-on-surface-variant w-4 h-4" />}
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-12 flex flex-col gap-4 sticky bottom-6">
        <Button variant="secondary" className="w-full" onClick={() => setShowLimit(true)}>
          <RefreshIcon />
          Regenerate Unselected
        </Button>
        <Button variant="primary" className="w-full" onClick={onContinue}>
          <CheckIcon />
          Keep & Continue ({selected.length})
        </Button>
      </div>

      <AnimatePresence>
        {showLimit && (
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
              
              <Button className="w-full mb-4" onClick={() => setShowLimit(false)}>
                Unlock & Save Pack (199 THB)
              </Button>
              <button className="text-primary font-bold hover:underline" onClick={() => setShowLimit(false)}>Wait for Reset</button>
              
              <div className="mt-8 flex flex-col items-center gap-2">
                <p className="text-[10px] uppercase tracking-widest text-on-surface-variant font-bold">Reset In</p>
                <div className="px-6 py-2 bg-surface-container rounded-full border border-border-light-purple">
                  <span className="font-bold text-primary tabular-nums">24:00:00</span>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

const CheckoutView = ({ onPay }: { onPay: () => void }) => (
  <div className="flex flex-col gap-8 p-6 max-w-md mx-auto">
    <div className="flex items-center justify-between">
      <Button variant="ghost" className="p-0 h-10 w-10"><BackIcon /></Button>
      <h2 className="text-xl font-extrabold text-primary">Unlock Pack</h2>
      <Button variant="ghost" className="p-0 h-10 w-10"><CloseIcon /></Button>
    </div>

    <div className="flex flex-col items-center text-center">
      <div className="w-48 h-48 rounded-[40px] bg-white border-4 border-border-light-purple shadow-xl mb-6 relative overflow-hidden flex items-center justify-center p-4">
        <img src={IMAGES.STICKER_PACK} alt="Pack" className="w-full h-full object-contain" />
        <div className="absolute -top-2 -right-2 bg-secondary-container p-2 rounded-full shadow-lg rotate-12">
          <StarIcon className="text-on-secondary-container" />
        </div>
      </div>
      <h3 className="text-2xl font-extrabold mb-2">Final Pack</h3>
      <div className="px-8 py-2 bg-surface-container rounded-full border-2 border-border-light-purple">
        <span className="text-3xl font-black text-ai-gradient italic">199 THB</span>
      </div>
    </div>

    <div className="bg-surface-container rounded-[32px] p-6 border-2 border-border-light-purple space-y-4">
      {[
        { icon: <HeartIcon />, text: 'Save all 16 unique stickers' },
        { icon: <HighQualityIcon />, text: 'High-resolution export' },
        { icon: <UnlockIcon />, text: 'Remove all creative limits' }
      ].map((f, i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="w-10 h-10 rounded-full bg-primary-fixed flex items-center justify-center text-primary">
            {f.icon}
          </div>
          <p className="font-bold text-on-surface">{f.text}</p>
        </div>
      ))}
    </div>

    <div className="mt-auto">
      <Button className="w-full py-6 text-xl" onClick={onPay}>
        <PayIcon />
        Pay & Save Now
      </Button>
      <p className="text-center text-xs text-on-surface-variant mt-4 opacity-70">Secure payment powered by Stripe.</p>
    </div>
  </div>
);

const SuccessView = () => {
  const [showVault, setShowVault] = useState(false);
  
  return (
    <div className="flex flex-col gap-10 p-6 min-h-screen">
      <section className="text-center mt-8">
        <div className="w-32 h-32 bg-success-teal/10 rounded-full flex items-center justify-center mx-auto relative mb-8 shadow-inner">
          <CheckIcon className="text-success-teal text-6xl" />
          <div className="absolute -bottom-4 w-24 h-24 rounded-full overflow-hidden border-4 border-background shadow-lg scale-110">
            <img src={IMAGES.CELEBRATION} alt="Cat" className="w-full h-full object-cover" />
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
          <span className="px-3 py-1 bg-primary-container text-white text-xs font-bold rounded-full">16 Stickers</span>
        </div>
        <div className="grid grid-cols-4 gap-2">
          {IMAGES.STICKERS.slice(0, 3).map((s, i) => (
            <img key={i} src={s} className="aspect-square object-cover rounded-xl bg-surface-container" />
          ))}
          <div className="aspect-square bg-surface-container flex items-center justify-center rounded-xl font-bold text-primary">+13</div>
        </div>
        <div className="flex flex-col gap-3">
          <Button variant="secondary" className="w-full h-12"><DownloadIcon /> Save to Photos</Button>
          <Button variant="line" className="w-full h-12 text-sm"><LineIcon /> Open LINE Sticker Maker</Button>
        </div>
      </div>

      <section className="pb-32">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <StarIcon className="text-secondary-container" />
            <h3 className="font-bold text-lg">The Extra Vault</h3>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-4">
          {IMAGES.STICKERS.slice(10, 14).map((s, i) => (
            <div key={i} onClick={() => setShowVault(true)} className="relative aspect-square rounded-3xl overflow-hidden cursor-pointer group">
              <img src={s} className="w-full h-full object-cover transition-transform group-hover:scale-105" />
              <div className="absolute inset-0 bg-black/20 backdrop-blur-[2px] flex items-center justify-center">
                <LockIcon className="text-white" />
              </div>
            </div>
          ))}
        </div>
      </section>

      <div className="fixed bottom-0 left-0 right-0 p-4 bg-white/80 backdrop-blur-md border-t border-border-light-purple z-40">
        <div className="max-w-md mx-auto flex items-center gap-4">
          <div className="flex-1">
            <p className="text-xs text-on-surface-variant font-bold">Unlock selected (2)</p>
            <p className="text-xl font-black text-primary italic">99 THB</p>
          </div>
          <Button onClick={() => setShowVault(true)} className="px-10"><PaymentsIcon /> Payment 99 THB</Button>
        </div>
      </div>

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
                <img src={IMAGES.STICKERS[2]} className="w-full h-full object-cover rounded-full border-4 border-secondary-container" />
                <div className="absolute -top-1 -right-1 bg-secondary-container p-1 rounded-full"><StarIcon className="text-xs" /></div>
              </div>
              <h3 className="text-2xl font-extrabold mb-1">Unlock Extra Vault</h3>
              <div className="text-2xl font-black text-primary mb-4 italic">99 THB</div>
              <p className="text-sm text-on-surface-variant mb-8">Secure all your hidden gems and save them to your gallery forever.</p>
              
              <div className="space-y-3 mb-8">
                <div className="flex items-center justify-between p-4 rounded-2xl border-2 border-primary bg-primary/5">
                  <div className="flex items-center gap-3 font-bold"><TokenIcon className="text-primary"/> PromptPay</div>
                  <div className="w-5 h-5 rounded-full border-4 border-primary bg-white"></div>
                </div>
                <div className="flex items-center justify-between p-4 rounded-2xl border border-outline-variant opacity-60">
                  <div className="flex items-center gap-3 font-medium text-on-surface-variant"><RobotIcon /> Credit Card</div>
                  <div className="w-5 h-5 rounded-full border border-outline-variant"></div>
                </div>
              </div>

              <Button className="w-full mb-4">Pay 99 THB</Button>
              <button className="text-on-surface-variant font-bold text-sm" onClick={() => setShowVault(false)}>Cancel</button>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [view, setView] = useState<View>(View.LOGIN);

  const renderView = () => {
    switch (view) {
      case View.LOGIN: return <LoginView onStart={() => setView(View.GENERATOR)} />;
      case View.GENERATOR: return <GeneratorView onGenerate={() => setView(View.GRID)} />;
      case View.GRID: return <GridView onContinue={() => setView(View.CHECKOUT)} />;
      case View.CHECKOUT: return <CheckoutView onPay={() => setView(View.SUCCESS)} />;
      case View.SUCCESS: return <SuccessView />;
      default: return <LoginView onStart={() => setView(View.GENERATOR)} />;
    }
  };

  return (
    <div className="min-h-screen bg-background font-sans text-on-background selection:bg-primary selection:text-white">
      {view !== View.LOGIN && view !== View.CHECKOUT && (
        <Header onNotify={() => {}} />
      )}
      
      <main className="max-w-xl mx-auto pb-12 overflow-x-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            transition={{ duration: 0.3, ease: 'easeInOut' }}
          >
            {renderView()}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  );
}
