export type TargetFps = 23.976 | 24 | 25 | 29.97 | 30 | 50 | 59.94 | 60;

export type TargetResolution = 'source' | '4k' | '1080p';

export type ColorTransferType =
  | 'bt709'
  | 'arib-std-b67' // HLG (iPhone Dolby Vision / HDR default)
  | 'smpte2084'    // PQ (HDR10)
  | 'apple-log'    // iPhone 15/16/17 Pro Apple Log
  | 'bt2020'
  | 'unknown';

export type StockPresetId = 'natural' | 'commercial' | 'golden' | 'cinema' | 'custom';

export interface VideoMetadata {
  /** True extracted frame rate (e.g. 23.976, 24, 25, 29.97, 30, 59.94, 60, 119.88, 240) */
  fps: number;
  width: number;
  height: number;
  duration: number;
  /** Video bitrate in Mbps */
  bitrateMbps?: number;
  colorSpace: string;
  colorTransfer: ColorTransferType;
  colorPrimaries: string;
  isHdrOrLog: boolean;
  /** Glanceable badge e.g. "4K 59.94 fps • Rec.709" or "4K 59.94 fps • HDR HLG" */
  badgeText: string;
}

export interface ClipEditSettings {
  /** Active stock preset identifier */
  preset: StockPresetId;
  /** Trim start in seconds (source timeline) */
  trimStart: number;
  /** Trim end in seconds (source timeline) */
  trimEnd: number;
  /** Exposure / brightness adjustment (-0.35 to +0.35, default 0) */
  exposure: number;
  /** Contrast multiplier (0.65 to 1.45, default 1.0) */
  contrast: number;
  /** Saturation multiplier (0.0 to 1.7, default 1.0) */
  saturation: number;
  /** Color warmth / temperature (-0.8 cool to +0.8 warm, default 0) */
  temperature: number;
  /** Unsharp mask luma amount (0.0 to 1.5, default 0.15) */
  sharpness: number;
  /** Normalize HDR / HLG / Apple Log input to standard Rec.709 */
  normalizeToRec709: boolean;
  /** Playback speed percentage of original footage (20% to 100%, default 100%) */
  speedPct: number;
  /** Playback speed multiplier derived from speedPct (0.20 to 1.0) */
  speed: number;
  /** Constant Frame Rate (CFR) target automatically derived from sourceFps * speedPct */
  targetFps: TargetFps;
  /** Output resolution preset */
  resolution: TargetResolution;
  /** Strip audio track (recommended for BlackBox stock clips) */
  stripAudio: boolean;
}

export type ClipStatus =
  | 'ready'
  | 'queued'
  | 'encoding'
  | 'uploading'
  | 'completed'
  | 'error';

export interface VideoClip {
  id: string;
  uri: string;
  fileName: string;
  /** Original source duration in seconds */
  sourceDuration: number;
  /** True extracted camera frame rate */
  sourceFps: number;
  width: number;
  height: number;
  fileSize?: number;
  metadata: VideoMetadata;
  edits: ClipEditSettings;
  status: ClipStatus;
  progress: number;
  statusMessage?: string;
  errorMessage?: string;
  remoteFileName?: string;
}

export interface BlackBoxFtpConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  remoteDir: string;
  secure: boolean;
  bridgeUrl: string;
  executionMode: 'bridge' | 'native';
}

export interface ComplianceCheckResult {
  isValid: boolean;
  outputDuration: number;
  effectiveFps: number;
  targetCfr: TargetFps;
  warnings: string[];
  errors: string[];
}

export interface StockPresetDefinition {
  id: Exclude<StockPresetId, 'custom'>;
  name: string;
  subtitle: string;
  values: Pick<
    ClipEditSettings,
    'exposure' | 'contrast' | 'saturation' | 'temperature' | 'sharpness'
  >;
}

export const STOCK_PRESETS: StockPresetDefinition[] = [
  {
    id: 'natural',
    name: 'Natural Stock',
    subtitle: 'Rec.709 neutral balance',
    values: {
      exposure: 0.0,
      contrast: 1.0,
      saturation: 1.0,
      temperature: 0.0,
      sharpness: 0.15,
    },
  },
  {
    id: 'commercial',
    name: 'Commercial Punch',
    subtitle: '+10% contrast · +15% color · crisp',
    values: {
      exposure: 0.01,
      contrast: 1.1,
      saturation: 1.15,
      temperature: 0.02,
      sharpness: 0.45,
    },
  },
  {
    id: 'golden',
    name: 'Golden Warmth',
    subtitle: 'Warm light · lifted shadows',
    values: {
      exposure: 0.04,
      contrast: 1.05,
      saturation: 1.12,
      temperature: 0.3,
      sharpness: 0.2,
    },
  },
  {
    id: 'cinema',
    name: 'Moody Cinema',
    subtitle: '-10% sat · deep blacks · cool tint',
    values: {
      exposure: -0.03,
      contrast: 1.14,
      saturation: 0.9,
      temperature: -0.18,
      sharpness: 0.25,
    },
  },
];

/**
 * Maps an effective frame rate (sourceFps * speedPct / 100) by clipping down
 * to the nearest smaller (or equal) agency-standard Constant Frame Rate (CFR)
 * so slowed-down footage never duplicates frames or stutters.
 * Under 29.98 fps, clips down to 25 fps; under 25 fps, clips down to 24 / 23.976 fps.
 */
export function pickTargetCfr(actualFps: number, sourceFps?: number): TargetFps {
  const isNtscFractional =
    sourceFps !== undefined &&
    (Math.abs(sourceFps - 23.976) < 0.05 ||
      Math.abs(sourceFps - 29.97) < 0.05 ||
      Math.abs(sourceFps - 59.94) < 0.08 ||
      Math.abs(sourceFps - 119.88) < 0.15);

  if (actualFps >= 59.98) {
    return isNtscFractional ? 59.94 : 60;
  }
  if (actualFps >= 59.9) {
    return 59.94;
  }
  if (actualFps >= 50.0) {
    return 50;
  }
  if (actualFps >= 29.98) {
    return isNtscFractional ? 29.97 : 30;
  }
  if (isNtscFractional && actualFps >= 29.94) {
    return 29.97;
  }
  if (actualFps >= 25.0) {
    return 25;
  }
  return isNtscFractional ? 23.976 : 24;
}

export function formatResolutionLabel(width: number, height: number): string {
  const longEdge = Math.max(width || 3840, height || 2160);
  if (longEdge >= 3800) return '4K';
  if (longEdge >= 2500) return '2.7K';
  if (longEdge >= 1900) return '1080p';
  if (longEdge >= 1200) return '720p';
  return `${width}×${height}`;
}

export function formatColorProfileLabel(transfer: ColorTransferType, space?: string): string {
  if (transfer === 'apple-log') return 'Apple Log';
  if (transfer === 'arib-std-b67') return 'HDR HLG';
  if (transfer === 'smpte2084') return 'HDR10 PQ';
  if (transfer === 'bt2020' || space === 'bt2020nc' || space === 'bt2020') return 'Rec.2020';
  return 'Rec.709';
}

export function buildMetadataBadge(
  width: number,
  height: number,
  fps: number,
  transfer: ColorTransferType,
  space?: string
): string {
  const resLabel = formatResolutionLabel(width, height);
  const fpsLabel = Number.isInteger(fps) ? `${fps} fps` : `${fps.toFixed(2).replace(/0$/, '')} fps`;
  const colorLabel = formatColorProfileLabel(transfer, space);
  return `${resLabel} ${fpsLabel} • ${colorLabel}`;
}

export const DEFAULT_EDIT_SETTINGS = (
  durationSec: number,
  sourceFps = 60,
  isHdrOrLog = false
): ClipEditSettings => {
  const safeDuration = Math.max(durationSec || 10, 5);
  return {
    preset: 'natural',
    trimStart: 0,
    trimEnd: Math.min(safeDuration, 59),
    exposure: 0,
    contrast: 1.0,
    saturation: 1.0,
    temperature: 0,
    sharpness: 0.15,
    normalizeToRec709: isHdrOrLog || true,
    speedPct: 100,
    speed: 1.0,
    targetFps: pickTargetCfr(sourceFps, sourceFps),
    resolution: 'source',
    stripAudio: true,
  };
};

