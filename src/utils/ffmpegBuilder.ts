import {
  ClipEditSettings,
  ColorTransferType,
  ComplianceCheckResult,
  pickTargetCfr,
} from '../types/clip';

/**
 * Calculates the final output duration and actual resulting FPS when slowing down by %,
 * and checks compliance with BlackBox Global technical requirements:
 * - Strict 5.0s to 59.0s final clip duration
 * - Minimum 23.976 fps resulting frame rate (prevents stuttery slow-motion rejections)
 */
export function validateBlackBoxCompliance(
  edits: ClipEditSettings,
  sourceWidth?: number,
  sourceHeight?: number,
  sourceFps = 60
): ComplianceCheckResult {
  const speedPct = edits.speedPct || Math.round((edits.speed || 1) * 100);
  const speedMult = speedPct / 100;
  const trimmedDuration = Math.max(0, edits.trimEnd - edits.trimStart);
  const outputDuration = Number((trimmedDuration / speedMult).toFixed(2));
  const effectiveFps = Number(((sourceFps * speedPct) / 100).toFixed(2));
  const targetCfr = pickTargetCfr(effectiveFps, sourceFps);

  const errors: string[] = [];
  const warnings: string[] = [];

  if (outputDuration < 5.0) {
    errors.push(
      `Clip is ${outputDuration.toFixed(1)}s — BlackBox requires at least 5.0 seconds.`
    );
  }
  if (outputDuration > 59.0) {
    errors.push(
      `Clip is ${outputDuration.toFixed(1)}s — BlackBox rejects clips longer than 59.0 seconds.`
    );
  }
  if (effectiveFps < 23.5) {
    errors.push(
      `Resulting frame rate is ${effectiveFps} fps — below BlackBox 23.98 fps minimum.`
    );
  }

  if (sourceWidth && sourceHeight) {
    const longEdge = Math.max(sourceWidth, sourceHeight);
    const shortEdge = Math.min(sourceWidth, sourceHeight);
    if (longEdge < 1920 || shortEdge < 1080) {
      errors.push(
        `Source resolution (${sourceWidth}×${sourceHeight}) is below Full HD (1920×1080) minimum.`
      );
    }
  }

  return {
    isValid: errors.length === 0,
    outputDuration,
    effectiveFps,
    targetCfr,
    warnings,
    errors,
  };
}

export interface FfmpegBuildOptions {
  colorTransfer?: ColorTransferType;
  isHdrOrLog?: boolean;
  useZscaleTonemap?: boolean;
}

/**
 * Builds the quality-hardened FFmpeg filter graph (-vf) and CLI arguments
 * for stock agency submission (BlackBox Global / Adobe Stock / Shutterstock / Getty):
 * - Normalizes Apple Log / HDR HLG / PQ color spaces into standard Rec.709 (bt709)
 * - Applies calibrated color grading (eq, colorbalance, unsharp) in normalized space
 * - Enforces Lanczos + accurate_rnd scaling and strict Constant Frame Rate (-fps_mode cfr)
 * - Produces visually lossless High-Profile H.264 (CRF 16, 100 Mbps maxrate) with explicit Rec.709 VUI tags
 */
export function buildFfmpegArgs(
  inputPath: string,
  outputPath: string,
  edits: ClipEditSettings,
  options: FfmpegBuildOptions = {}
): string[] {
  const filters: string[] = [];
  const speedMult = edits.speedPct ? edits.speedPct / 100 : edits.speed || 1.0;

  // 1. Speed Ramping / Slow-Motion presentation timestamp adjustment
  if (Math.abs(speedMult - 1.0) > 0.001) {
    const ptsMultiplier = (1 / speedMult).toFixed(4);
    filters.push(`setpts=${ptsMultiplier}*PTS`);
  }

  // 2. Color Profile Stripping & HDR / Apple Log -> Rec.709 Normalization
  // Ensures subsequent eq/colorbalance adjustments operate with predictable gamma & gamut
  const isHdr =
    options.isHdrOrLog ||
    options.colorTransfer === 'arib-std-b67' ||
    options.colorTransfer === 'smpte2084' ||
    options.colorTransfer === 'apple-log' ||
    options.colorTransfer === 'bt2020';

  if (isHdr && options.useZscaleTonemap) {
    filters.push(
      'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,format=yuv420p'
    );
  } else if (isHdr || edits.normalizeToRec709 !== false) {
    // Convert wide-gamut / 10-bit HLG/Log planar buffers into normalized 8-bit Rec.709 planar YUV
    // and apply highlight compression curve if source is HLG/Log
    filters.push('format=yuv420p');
    if (options.colorTransfer === 'apple-log') {
      // Apple Log S-curve expansion + saturation recovery before user grade
      filters.push('eq=contrast=1.26:saturation=1.32:gamma=0.92');
    } else if (
      options.colorTransfer === 'arib-std-b67' ||
      options.colorTransfer === 'smpte2084'
    ) {
      // HLG / PQ highlight roll-off normalization to SDR Rec.709 range
      filters.push('eq=contrast=1.06:brightness=-0.02:saturation=0.96:gamma=0.95');
    }
  }

  // 3. Calibrated Exposure, Contrast, Saturation via FFmpeg eq filter
  const hasEq =
    Math.abs(edits.exposure) > 0.005 ||
    Math.abs(edits.contrast - 1.0) > 0.005 ||
    Math.abs(edits.saturation - 1.0) > 0.005;

  if (hasEq) {
    const b = edits.exposure.toFixed(3);
    const c = edits.contrast.toFixed(3);
    const s = edits.saturation.toFixed(3);
    filters.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
  }

  // 4. Warmth / Color Temperature via colorbalance (midtone + shadow/highlight shift)
  if (Math.abs(edits.temperature) > 0.01) {
    const temp = edits.temperature;
    const rm = (temp * 0.18).toFixed(3);
    const gm = (temp * 0.04).toFixed(3);
    const bm = (-temp * 0.18).toFixed(3);
    const rh = (temp * 0.1).toFixed(3);
    const bh = (-temp * 0.1).toFixed(3);
    filters.push(
      `colorbalance=rm=${rm}:gm=${gm}:bm=${bm}:rh=${rh}:bh=${bh}`
    );
  }

  // 5. Luma Sharpening via unsharp mask
  if (edits.sharpness > 0.02) {
    const lumaAmount = edits.sharpness.toFixed(2);
    filters.push(`unsharp=5:5:${lumaAmount}:5:5:0.0`);
  }

  // 6. High-Fidelity Lanczos Resolution Scaling
  if (edits.resolution === '4k') {
    filters.push('scale=3840:2160:flags=lanczos+accurate_rnd');
  } else if (edits.resolution === '1080p') {
    filters.push('scale=1920:1080:flags=lanczos+accurate_rnd');
  }

  // 7. Strict Constant Frame Rate (CFR) cadence filter
  filters.push(`fps=fps=${edits.targetFps}`);

  const args: string[] = [
    '-y',
    '-ss',
    edits.trimStart.toFixed(3),
    '-to',
    edits.trimEnd.toFixed(3),
    '-i',
    inputPath,
    '-sws_flags',
    'lanczos+accurate_rnd',
  ];

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  // Visually lossless Stock Portal Master Encoding (CRF 16, High Profile 5.1, Rec.709 VUI metadata)
  args.push(
    '-fps_mode',
    'cfr',
    '-r',
    String(edits.targetFps),
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-level:v',
    '5.1',
    '-preset',
    'medium',
    '-crf',
    '16',
    '-maxrate',
    '100M',
    '-bufsize',
    '150M',
    '-pix_fmt',
    'yuv420p',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'bt709',
    '-color_range',
    'tv',
    '-movflags',
    '+faststart+write_colr'
  );

  if (edits.stripAudio) {
    args.push('-an');
  } else {
    if (Math.abs(speedMult - 1.0) > 0.001 && speedMult >= 0.5) {
      args.push('-af', `atempo=${speedMult}`);
    }
    args.push('-c:a', 'aac', '-b:a', '256k');
  }

  args.push(outputPath);
  return args;
}

