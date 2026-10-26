import * as FileSystem from 'expo-file-system/legacy';
import { BlackBoxFtpConfig, VideoClip } from '../types/clip';
import { buildFfmpegArgs } from '../utils/ffmpegBuilder';

export interface ProgressUpdate {
  status: 'encoding' | 'uploading' | 'completed' | 'error';
  progress: number;
  message: string;
  remoteFileName?: string;
}

/**
 * Tests connection to the BlackBox Global FTP portal (and/or companion bridge)
 */
export async function testBlackBoxFtpConnection(
  config: BlackBoxFtpConfig
): Promise<{ ok: boolean; message: string }> {
  const baseUrl = config.bridgeUrl.replace(/\/$/, '');
  try {
    const res = await fetch(`${baseUrl}/api/test-ftp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        secure: config.secure,
        remoteDir: config.remoteDir,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      return {
        ok: false,
        message: data.error || `Connection failed (${res.status})`,
      };
    }
    return {
      ok: true,
      message: data.message || 'Connected to portal.blackbox.global FTPS!',
    };
  } catch (err: any) {
    return {
      ok: false,
      message: `Cannot reach processing engine at ${baseUrl}. Make sure the bridge is running (npm run dev) or switch to Native IPA mode. (${err?.message || 'Network error'})`,
    };
  }
}

/**
 * Processes a video clip (Trim + Color Grade + Slow-Mo + VFR->CFR conversion)
 * and uploads it directly to portal.blackbox.global via Explicit FTPS.
 *
 * Supports two modes:
 * 1. Native On-Device Mode (when built as standalone iOS .ipa with ffmpeg-kit-react-native)
 * 2. Companion Bridge Mode (works immediately inside Expo Go on iPhone)
 */
export async function processAndUploadClip(
  clip: VideoClip,
  ftpConfig: BlackBoxFtpConfig,
  onProgress: (update: ProgressUpdate) => void
): Promise<void> {
  // Check if native FFmpegKit is linked (standalone iOS IPA build)
  const globalAny = globalThis as any;
  if (ftpConfig.executionMode === 'native' && globalAny.FFmpegKit) {
    await runNativeOnDevicePipeline(clip, ftpConfig, onProgress);
    return;
  }

  // Otherwise run via the Companion Bridge (works in Expo Go & standalone)
  await runBridgePipeline(clip, ftpConfig, onProgress);
}

async function runNativeOnDevicePipeline(
  clip: VideoClip,
  ftpConfig: BlackBoxFtpConfig,
  onProgress: (update: ProgressUpdate) => void
): Promise<void> {
  const globalAny = globalThis as any;
  const cacheDir = FileSystem.cacheDirectory || '';
  const sanitizedBase = clip.fileName.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const outputFileName = `${sanitizedBase}_BB_${clip.edits.targetFps}fps_CFR.mp4`;
  const outputPath = `${cacheDir}${outputFileName}`;

  onProgress({
    status: 'encoding',
    progress: 0.1,
    message: `Encoding CFR (${clip.edits.targetFps} fps) on iPhone...`,
  });

  const args = buildFfmpegArgs(
    clip.uri.replace('file://', ''),
    outputPath.replace('file://', ''),
    clip.edits,
    {
      colorTransfer: clip.metadata?.colorTransfer,
      isHdrOrLog: clip.metadata?.isHdrOrLog,
    }
  );

  const session = await globalAny.FFmpegKit.executeWithArgumentsAsync(args);
  const returnCode = await session.getReturnCode();
  if (!returnCode.isValueSuccess()) {
    const logs = await session.getOutput();
    throw new Error(`On-device FFmpeg failed: ${logs?.slice(-300) || 'Unknown error'}`);
  }

  onProgress({
    status: 'uploading',
    progress: 0.65,
    message: `Uploading ${outputFileName} to ${ftpConfig.host}...`,
  });

  // Upload the already-encoded CFR file via FTPS endpoint
  const baseUrl = ftpConfig.bridgeUrl.replace(/\/$/, '');
  const uploadRes = await FileSystem.uploadAsync(`${baseUrl}/api/upload-only`, outputPath, {
    fieldName: 'video',
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.MULTIPART,
    parameters: {
      ftpConfig: JSON.stringify({
        host: ftpConfig.host,
        port: ftpConfig.port,
        username: ftpConfig.username,
        password: ftpConfig.password,
        secure: ftpConfig.secure,
        remoteDir: ftpConfig.remoteDir,
      }),
      outputFileName,
    },
  });

  if (uploadRes.status < 200 || uploadRes.status >= 300) {
    throw new Error(`FTP upload failed (${uploadRes.status}): ${uploadRes.body}`);
  }

  onProgress({
    status: 'completed',
    progress: 1.0,
    message: `Uploaded to ${ftpConfig.host}/${outputFileName}`,
    remoteFileName: outputFileName,
  });
}

async function runBridgePipeline(
  clip: VideoClip,
  ftpConfig: BlackBoxFtpConfig,
  onProgress: (update: ProgressUpdate) => void
): Promise<void> {
  const baseUrl = ftpConfig.bridgeUrl.replace(/\/$/, '');
  const jobId = `${clip.id}_${Date.now()}`;

  onProgress({
    status: 'encoding',
    progress: 0.08,
    message: 'Sending clip to CFR & FTPS pipeline...',
  });

  // Start polling job status while upload + FFmpeg + FTPS runs
  let polling = true;
  const pollLoop = (async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, 800));
      if (!polling) break;
      try {
        const res = await fetch(`${baseUrl}/api/job/${jobId}`);
        if (res.ok) {
          const job = await res.json();
          if (job && job.status) {
            onProgress({
              status: job.status,
              progress: job.progress ?? 0.5,
              message: job.message || 'Processing...',
              remoteFileName: job.remoteFileName,
            });
          }
        }
      } catch {
        // Ignore transient poll errors
      }
    }
  })();

  try {
    const uploadTask = FileSystem.createUploadTask(
      `${baseUrl}/api/process-and-upload`,
      clip.uri,
      {
        fieldName: 'video',
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.MULTIPART,
        parameters: {
          jobId,
          originalName: clip.fileName,
          edits: JSON.stringify(clip.edits),
          metadata: JSON.stringify(clip.metadata || {}),
          ftpConfig: JSON.stringify({
            host: ftpConfig.host,
            port: ftpConfig.port,
            username: ftpConfig.username,
            password: ftpConfig.password,
            secure: ftpConfig.secure,
            remoteDir: ftpConfig.remoteDir,
          }),
        },
      },
      (data) => {
        const transferRatio =
          data.totalBytesExpectedToSend > 0
            ? data.totalBytesSent / data.totalBytesExpectedToSend
            : 0;
        if (transferRatio < 0.99) {
          onProgress({
            status: 'encoding',
            progress: Math.min(0.3, transferRatio * 0.3),
            message: `Transferring from iPhone (${Math.round(transferRatio * 100)}%)...`,
          });
        }
      }
    );

    const result = await uploadTask.uploadAsync();
    polling = false;
    await pollLoop;

    if (!result) {
      throw new Error('Upload task returned no response.');
    }

    let parsed: any = {};
    try {
      parsed = JSON.parse(result.body);
    } catch {
      parsed = { error: result.body };
    }

    if (result.status < 200 || result.status >= 300 || !parsed.ok) {
      throw new Error(parsed.error || `Pipeline failed with status ${result.status}`);
    }

    onProgress({
      status: 'completed',
      progress: 1.0,
      message: parsed.message || `Uploaded ${parsed.remoteFileName} to BlackBox!`,
      remoteFileName: parsed.remoteFileName,
    });
  } finally {
    polling = false;
  }
}
