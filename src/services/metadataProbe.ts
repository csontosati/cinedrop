import * as FileSystem from 'expo-file-system/legacy';
import {
  buildMetadataBadge,
  ColorTransferType,
  VideoMetadata,
} from '../types/clip';

const STANDARD_FRAMERATES = [
  23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 119.88, 120, 240,
];

/**
 * Snaps a raw measured frame rate (e.g. 59.940059 or 29.970029) to its canonical
 * broadcast/cinema rate while preserving true fractional NTSC rates.
 */
export function snapToCanonicalFps(rawFps: number): number {
  if (!rawFps || !Number.isFinite(rawFps) || rawFps <= 0) return 60;
  let closest: number | null = null;
  let minDiff = 0.08;
  for (const std of STANDARD_FRAMERATES) {
    const diff = Math.abs(rawFps - std);
    if (diff < minDiff) {
      minDiff = diff;
      closest = std;
    }
  }
  return closest !== null ? closest : Number(rawFps.toFixed(2));
}

/**
 * Parses an ffprobe r_frame_rate / avg_frame_rate string such as "60000/1001" or "30/1"
 */
export function parseRationalFps(rational?: string): number | null {
  if (!rational) return null;
  if (rational.includes('/')) {
    const [numStr, denStr] = rational.split('/');
    const num = parseFloat(numStr);
    const den = parseFloat(denStr);
    if (num > 0 && den > 0) {
      return snapToCanonicalFps(num / den);
    }
  }
  const direct = parseFloat(rational);
  return direct > 0 ? snapToCanonicalFps(direct) : null;
}

/**
 * Normalizes transfer characteristic strings from ffprobe / AVAsset / NCLX atoms
 */
export function normalizeColorTransfer(
  rawTransfer?: string,
  rawSpace?: string,
  codecTag?: string
): { transfer: ColorTransferType; isHdrOrLog: boolean } {
  const t = (rawTransfer || '').toLowerCase();
  const s = (rawSpace || '').toLowerCase();
  const c = (codecTag || '').toLowerCase();

  if (t.includes('log') || c === 'apcn' || c === 'apch' || c === 'ap4h') {
    if (t.includes('log')) {
      return { transfer: 'apple-log', isHdrOrLog: true };
    }
  }
  if (t.includes('arib-std-b67') || t.includes('hlg')) {
    return { transfer: 'arib-std-b67', isHdrOrLog: true };
  }
  if (t.includes('smpte2084') || t.includes('pq')) {
    return { transfer: 'smpte2084', isHdrOrLog: true };
  }
  if (s.includes('bt2020') || t.includes('bt2020')) {
    return { transfer: 'bt2020', isHdrOrLog: true };
  }
  return { transfer: 'bt709', isHdrOrLog: false };
}

/**
 * Fast ISO-BMFF (MP4 / QuickTime MOV) binary atom scanner.
 * Extracts true media timescale (`mdhd`), sample delta (`stts`), and NCLX color (`colr`)
 * from a Uint8Array buffer without decoding video frames.
 */
export function parseIsoBmffMetadataFromBuffer(
  bytes: Uint8Array
): {
  fps?: number;
  colorTransfer?: ColorTransferType;
  colorSpace?: string;
  isHdrOrLog?: boolean;
} {
  const result: {
    fps?: number;
    colorTransfer?: ColorTransferType;
    colorSpace?: string;
    isHdrOrLog?: boolean;
  } = {};

  const len = bytes.byteLength;
  if (len < 64) return result;

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const timescales: number[] = [];

  for (let i = 0; i < len - 28; i++) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const b3 = bytes[i + 3];

    // 'mdhd' atom (0x6d646864): Media Header containing track timescale
    if (b0 === 0x6d && b1 === 0x64 && b2 === 0x68 && b3 === 0x64) {
      const version = bytes[i + 4];
      const tsOffset = version === 1 ? i + 24 : i + 16;
      if (tsOffset + 4 <= len) {
        const ts = dv.getUint32(tsOffset);
        if (ts >= 24 && ts <= 1000000) {
          timescales.push(ts);
        }
      }
    }

    // 'colr' atom (0x636f6c72): Color parameter box ('nclx')
    if (b0 === 0x63 && b1 === 0x6f && b2 === 0x6c && b3 === 0x72) {
      if (
        i + 15 <= len &&
        bytes[i + 4] === 0x6e && // 'n'
        bytes[i + 5] === 0x63 && // 'c'
        bytes[i + 6] === 0x6c && // 'l'
        bytes[i + 7] === 0x78    // 'x'
      ) {
        const primaries = dv.getUint16(i + 8);
        const trc = dv.getUint16(i + 10);
        // ITU-T H.273 transfer characteristics: 1=bt709, 14/15=bt2020, 16=smpte2084 (PQ), 18=arib-std-b67 (HLG)
        if (trc === 18) {
          result.colorTransfer = 'arib-std-b67';
          result.colorSpace = 'bt2020nc';
          result.isHdrOrLog = true;
        } else if (trc === 16) {
          result.colorTransfer = 'smpte2084';
          result.colorSpace = 'bt2020nc';
          result.isHdrOrLog = true;
        } else if (primaries === 9 || trc === 14 || trc === 15) {
          result.colorTransfer = 'bt2020';
          result.colorSpace = 'bt2020nc';
          result.isHdrOrLog = true;
        } else {
          result.colorTransfer = 'bt709';
          result.colorSpace = 'bt709';
          result.isHdrOrLog = false;
        }
      }
    }

    // 'stts' atom (0x73747473): Time-to-Sample table
    if (
      !result.fps &&
      b0 === 0x73 &&
      b1 === 0x74 &&
      b2 === 0x74 &&
      b3 === 0x73
    ) {
      if (i + 20 <= len) {
        const entryCount = dv.getUint32(i + 8);
        const sampleCount = dv.getUint32(i + 12);
        const sampleDelta = dv.getUint32(i + 16);

        if (
          entryCount >= 1 &&
          entryCount < 500000 &&
          sampleCount >= 5 &&
          sampleDelta > 0 &&
          sampleDelta <= 5000
        ) {
          const candidates = [
            ...timescales,
            600,
            60000,
            90000,
            30000,
            24000,
            25000,
          ];
          for (const ts of candidates) {
            const rawFps = ts / sampleDelta;
            for (const std of STANDARD_FRAMERATES) {
              if (Math.abs(rawFps - std) < 0.12) {
                result.fps = std;
                break;
              }
            }
            if (result.fps) break;
          }
        }
      }
    }
  }

  return result;
}

/**
 * Automatically extracts true framerate (FPS), color profile (Rec.709 / HDR HLG / PQ / Apple Log),
 * resolution, duration, and bitrate from a picked video asset.
 */
export async function probeVideoMetadata(params: {
  uri: string;
  width?: number;
  height?: number;
  durationSec?: number;
  fileSize?: number;
  bridgeUrl?: string;
}): Promise<VideoMetadata> {
  const width = params.width || 3840;
  const height = params.height || 2160;
  const duration = Number((params.durationSec || 12).toFixed(2));
  const bitrateMbps =
    params.fileSize && duration > 0
      ? Number(((params.fileSize * 8) / (duration * 1_000_000)).toFixed(1))
      : undefined;

  let fps = 60;
  let colorTransfer: ColorTransferType = 'bt709';
  let colorSpace = 'bt709';
  let colorPrimaries = 'bt709';
  let isHdrOrLog = false;

  // 1. Try Native FFprobeKit if running in standalone native IPA build
  const globalAny = globalThis as any;
  if (globalAny.FFprobeKit) {
    try {
      const session = await globalAny.FFprobeKit.getMediaInformationAsync(
        params.uri
      );
      const info = session.getMediaInformation();
      const streams = info?.getStreams?.() || [];
      const vStream = streams.find(
        (s: any) => s.getType?.() === 'video' || s.getAllProperties?.()?.codec_type === 'video'
      );
      if (vStream) {
        const props = vStream.getAllProperties?.() || {};
        const parsedFps =
          parseRationalFps(props.avg_frame_rate) ||
          parseRationalFps(props.r_frame_rate);
        if (parsedFps) fps = parsedFps;

        const norm = normalizeColorTransfer(
          props.color_transfer,
          props.color_space,
          props.codec_tag_string
        );
        colorTransfer = norm.transfer;
        isHdrOrLog = norm.isHdrOrLog;
        colorSpace = props.color_space || 'bt709';
        colorPrimaries = props.color_primaries || 'bt709';
      }
    } catch {}
  }

  // 2. Try fast local ISO-BMFF atom header inspection via expo-file-system
  try {
    const b64Head = await FileSystem.readAsStringAsync(params.uri, {
      encoding: FileSystem.EncodingType.Base64,
      position: 0,
      length: 262144, // First 256 KB
    });
    if (b64Head) {
      const binStr = globalThis.atob ? globalThis.atob(b64Head) : '';
      if (binStr.length > 64) {
        const bytes = new Uint8Array(binStr.length);
        for (let i = 0; i < binStr.length; i++) {
          bytes[i] = binStr.charCodeAt(i);
        }
        const parsed = parseIsoBmffMetadataFromBuffer(bytes);
        if (parsed.fps) fps = parsed.fps;
        if (parsed.colorTransfer) {
          colorTransfer = parsed.colorTransfer;
          colorSpace = parsed.colorSpace || 'bt709';
          isHdrOrLog = !!parsed.isHdrOrLog;
        }
      }
    }
  } catch {}

  const badgeText = buildMetadataBadge(
    width,
    height,
    fps,
    colorTransfer,
    colorSpace
  );

  return {
    fps,
    width,
    height,
    duration,
    bitrateMbps,
    colorSpace,
    colorTransfer,
    colorPrimaries,
    isHdrOrLog,
    badgeText,
  };
}
