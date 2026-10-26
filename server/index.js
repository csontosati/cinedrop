const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const ftp = require('basic-ftp');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const app = express();
app.use(cors());
app.use(express.json());

const workDir = path.join(os.tmpdir(), 'bb-direct-studio');
if (!fs.existsSync(workDir)) {
  fs.mkdirSync(workDir, { recursive: true });
}

const upload = multer({
  dest: workDir,
  limits: {
    fileSize: 4 * 1024 * 1024 * 1024, // 4GB max video payload
  },
});

// In-memory job status tracker with automated cleanup to prevent memory exhaustion
const jobs = new Map();

function setJobStatus(jobId, data) {
  jobs.set(jobId, {
    ...data,
    updatedAt: Date.now(),
  });
}

// Periodically prune completed/error jobs older than 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.updatedAt && now - job.updatedAt > 30 * 60 * 1000) {
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000).unref();

const STANDARD_FRAMERATES = [
  23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 119.88, 120, 240,
];

function snapToCanonicalFps(rawFps) {
  if (!rawFps || !Number.isFinite(rawFps) || rawFps <= 0) return 60;
  let closest = null;
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

function parseRationalFps(rational) {
  if (!rational) return null;
  if (rational.includes('/')) {
    const [n, d] = rational.split('/').map(Number);
    if (n > 0 && d > 0) return snapToCanonicalFps(n / d);
  }
  const direct = parseFloat(rational);
  return direct > 0 ? snapToCanonicalFps(direct) : null;
}

function probeMediaFile(filePath) {
  const probeRes = spawnSync(ffprobePath, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,r_frame_rate,avg_frame_rate,color_space,color_transfer,color_primaries,codec_tag_string,bit_rate:format=duration,bit_rate',
    '-of',
    'json',
    filePath,
  ]);

  if (probeRes.status !== 0) {
    return null;
  }

  try {
    const parsed = JSON.parse(probeRes.stdout.toString());
    const s = (parsed.streams && parsed.streams[0]) || {};
    const f = parsed.format || {};
    const fps =
      parseRationalFps(s.avg_frame_rate) ||
      parseRationalFps(s.r_frame_rate) ||
      60;
    const width = Number(s.width) || 3840;
    const height = Number(s.height) || 2160;
    const duration = parseFloat(f.duration) || 12;
    const rawTransfer = (s.color_transfer || '').toLowerCase();
    const rawSpace = (s.color_space || '').toLowerCase();

    let colorTransfer = 'bt709';
    let colorLabel = 'Rec.709';
    let isHdrOrLog = false;
    if (rawTransfer.includes('log')) {
      colorTransfer = 'apple-log';
      colorLabel = 'Apple Log';
      isHdrOrLog = true;
    } else if (rawTransfer.includes('arib-std-b67')) {
      colorTransfer = 'arib-std-b67';
      colorLabel = 'HDR HLG';
      isHdrOrLog = true;
    } else if (rawTransfer.includes('smpte2084')) {
      colorTransfer = 'smpte2084';
      colorLabel = 'HDR10 PQ';
      isHdrOrLog = true;
    } else if (rawSpace.includes('bt2020') || rawTransfer.includes('bt2020')) {
      colorTransfer = 'bt2020';
      colorLabel = 'Rec.2020';
      isHdrOrLog = true;
    }

    const maxDim = Math.max(width, height);
    const resLabel =
      maxDim >= 3840 ? '4K' : maxDim >= 2560 ? '2.7K' : maxDim >= 1920 ? '1080p' : `${height}p`;
    const badge = `${resLabel} ${fps} fps • ${colorLabel}`;

    return {
      fps,
      width,
      height,
      duration: Number(duration.toFixed(2)),
      colorSpace: s.color_space || 'bt709',
      colorTransfer,
      colorPrimaries: s.color_primaries || 'bt709',
      isHdrOrLog,
      badge,
    };
  } catch {
    return null;
  }
}

/**
 * Quality-hardened FFmpeg pipeline for BlackBox Global stock footage:
 * - Normalizes Apple Log / HDR HLG / PQ color spaces to standard Rec.709 (bt709)
 * - Applies calibrated exposure, contrast, saturation, warmth, and unsharp mask
 * - Uses Lanczos + accurate_rnd scaling and strict Constant Frame Rate (-fps_mode cfr)
 * - Encodes visually lossless High-Profile H.264 (CRF 16, 100M maxrate) with explicit Rec.709 VUI tags
 */
function buildFfmpegArgsServer(inputPath, outputPath, edits = {}, metadata = {}) {
  const filters = [];
  const rawSpeed = edits.speedPct
    ? Number(edits.speedPct) / 100
    : Number(edits.speed || 1.0);
  const speedMult = Math.max(0.1, Math.min(10.0, isNaN(rawSpeed) ? 1.0 : rawSpeed));

  if (Math.abs(speedMult - 1.0) > 0.001) {
    const ptsMultiplier = (1 / speedMult).toFixed(4);
    filters.push(`setpts=${ptsMultiplier}*PTS`);
  }

  // Color Profile Normalization (HDR HLG / PQ / Apple Log -> Rec.709)
  const allowedTransfers = ['bt709', 'arib-std-b67', 'smpte2084', 'apple-log', 'bt2020'];
  const rawTransfer = metadata.colorTransfer || edits.colorTransfer || 'bt709';
  const colorTransfer = allowedTransfers.includes(rawTransfer) ? rawTransfer : 'bt709';

  filters.push('format=yuv420p');
  if (colorTransfer === 'apple-log') {
    filters.push('eq=contrast=1.26:saturation=1.32:gamma=0.92');
  } else if (colorTransfer === 'arib-std-b67' || colorTransfer === 'smpte2084') {
    filters.push('eq=contrast=1.06:brightness=-0.02:saturation=0.96:gamma=0.95');
  }

  const exposure = Math.max(-2.0, Math.min(2.0, Number(edits.exposure) || 0));
  const contrast = Math.max(0.0, Math.min(3.0, Number(edits.contrast ?? 1.0)));
  const saturation = Math.max(0.0, Math.min(3.0, Number(edits.saturation ?? 1.0)));
  const temperature = Math.max(-2.0, Math.min(2.0, Number(edits.temperature) || 0));
  const sharpness = Math.max(0.0, Math.min(2.0, Number(edits.sharpness ?? 0.15)));

  if (
    Math.abs(exposure) > 0.005 ||
    Math.abs(contrast - 1.0) > 0.005 ||
    Math.abs(saturation - 1.0) > 0.005
  ) {
    filters.push(
      `eq=brightness=${exposure.toFixed(3)}:contrast=${contrast.toFixed(
        3
      )}:saturation=${saturation.toFixed(3)}`
    );
  }

  if (Math.abs(temperature) > 0.01) {
    const rm = (temperature * 0.18).toFixed(3);
    const gm = (temperature * 0.04).toFixed(3);
    const bm = (-temperature * 0.18).toFixed(3);
    const rh = (temperature * 0.1).toFixed(3);
    const bh = (-temperature * 0.1).toFixed(3);
    filters.push(
      `colorbalance=rm=${rm}:gm=${gm}:bm=${bm}:rh=${rh}:bh=${bh}`
    );
  }

  if (sharpness > 0.02) {
    filters.push(`unsharp=5:5:${sharpness.toFixed(2)}:5:5:0.0`);
  }

  if (edits.resolution === '4k') {
    filters.push('scale=3840:2160:flags=lanczos+accurate_rnd');
  } else if (edits.resolution === '1080p') {
    filters.push('scale=1920:1080:flags=lanczos+accurate_rnd');
  }

  const parsedFps = Number(edits.targetFps);
  const targetFps = STANDARD_FRAMERATES.includes(parsedFps) ? parsedFps : 30;
  filters.push(`fps=fps=${targetFps}`);

  const trimStart = Math.max(0, Number(edits.trimStart) || 0);
  const trimEnd = Math.max(trimStart + 0.1, Number(edits.trimEnd) || 10);

  const args = [
    '-y',
    '-ss',
    trimStart.toFixed(3),
    '-to',
    trimEnd.toFixed(3),
    '-i',
    inputPath,
    '-sws_flags',
    'lanczos+accurate_rnd',
  ];

  if (filters.length > 0) {
    args.push('-vf', filters.join(','));
  }

  args.push(
    '-fps_mode',
    'cfr',
    '-r',
    String(targetFps),
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

  if (edits.stripAudio !== false) {
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

function getLocalLanIps() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'ui.html'));
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'BB Direct Studio Bridge',
    ffmpeg: ffmpegPath,
    lanIps: getLocalLanIps(),
  });
});

app.post('/api/probe', upload.single('video'), (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: 'No video file provided.' });
  }
  try {
    const info = probeMediaFile(file.path);
    if (!info) {
      return res.status(500).json({ ok: false, error: 'Failed to probe media.' });
    }
    res.json({ ok: true, metadata: info });
  } finally {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch {}
  }
});

app.get('/api/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.json({
      status: 'encoding',
      progress: 0.1,
      message: 'Initializing...',
    });
  }
  res.json(job);
});

app.post('/api/test-ftp', async (req, res) => {
  const { host, port, username, password, secure, remoteDir } = req.body || {};
  if (!host || !username || !password) {
    return res.status(400).json({
      ok: false,
      error: 'Please provide host, username, and password.',
    });
  }

  const client = new ftp.Client(15000);
  const rejectUnauthorized = process.env.FTPS_REJECT_UNAUTHORIZED !== 'false';
  try {
    await client.access({
      host,
      port: Number(port) || 21,
      user: username,
      password,
      secure: secure !== false,
      secureOptions: { rejectUnauthorized },
    });
    if (remoteDir && remoteDir !== '/') {
      await client.ensureDir(remoteDir);
    }
    const list = await client.list();
    res.json({
      ok: true,
      message: `Connected to ${host} via FTPS (${list.length} items in workspace)`,
    });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: `FTPS Error: ${err.message}`,
    });
  } finally {
    client.close();
  }
});

app.post('/api/process-and-upload', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: 'No video file received.' });
  }

  const jobId = req.body.jobId || `job_${Date.now()}`;
  const originalName = req.body.originalName || file.originalname || 'clip.mov';
  let edits = {};
  let ftpConfig = {};
  let clientMetadata = {};

  try {
    edits = JSON.parse(req.body.edits || '{}');
    ftpConfig = JSON.parse(req.body.ftpConfig || '{}');
    clientMetadata = JSON.parse(req.body.metadata || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON parameters.' });
  }

  // Probe the uploaded source file directly with ffprobe to ensure exact color space & FPS awareness
  const probed = probeMediaFile(file.path) || clientMetadata;

  const baseName = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetFps = edits.targetFps || 30;
  const outputFileName = `${baseName}_BB_${targetFps}fps_CFR_${Date.now()
    .toString()
    .slice(-4)}.mp4`;
  const outputPath = path.join(workDir, outputFileName);

  const speedMult = edits.speedPct
    ? Number(edits.speedPct) / 100
    : Number(edits.speed || 1);
  const expectedOutDuration = Math.max(
    1,
    ((edits.trimEnd || 10) - (edits.trimStart || 0)) / speedMult
  );

  setJobStatus(jobId, {
    status: 'encoding',
    progress: 0.32,
    message: `Encoding ${targetFps}fps Rec.709 Master...`,
  });

  try {
    await new Promise((resolve, reject) => {
      const ffmpegArgs = buildFfmpegArgsServer(
        file.path,
        outputPath,
        edits,
        probed
      );
      const proc = spawn(ffmpegPath, ffmpegArgs);
      let stderrLog = '';

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrLog += text;
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const secs =
            parseInt(timeMatch[1], 10) * 3600 +
            parseInt(timeMatch[2], 10) * 60 +
            parseFloat(timeMatch[3]);
          const encodeRatio = Math.min(1, secs / expectedOutDuration);
          setJobStatus(jobId, {
            status: 'encoding',
            progress: Number((0.32 + encodeRatio * 0.35).toFixed(2)),
            message: `Encoding ${targetFps}fps CFR (${Math.round(
              encodeRatio * 100
            )}%)...`,
          });
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`FFmpeg exited with code ${code}: ${stderrLog.slice(-300)}`)
          );
      });

      proc.on('error', reject);
    });

    const totalBytes = fs.statSync(outputPath).size;
    setJobStatus(jobId, {
      status: 'uploading',
      progress: 0.7,
      message: `Connecting to ${ftpConfig.host || 'portal.blackbox.global'}...`,
    });

    const client = new ftp.Client(60000);
    const rejectUnauthorized = process.env.FTPS_REJECT_UNAUTHORIZED !== 'false';
    try {
      await client.access({
        host: ftpConfig.host || 'portal.blackbox.global',
        port: Number(ftpConfig.port) || 21,
        user: ftpConfig.username,
        password: ftpConfig.password,
        secure: ftpConfig.secure !== false,
        secureOptions: { rejectUnauthorized },
      });

      if (ftpConfig.remoteDir && ftpConfig.remoteDir !== '/') {
        await client.ensureDir(ftpConfig.remoteDir);
      }

      client.trackProgress((info) => {
        const ratio =
          totalBytes > 0 ? Math.min(1, info.bytes / totalBytes) : 0.5;
        setJobStatus(jobId, {
          status: 'uploading',
          progress: Number((0.7 + ratio * 0.29).toFixed(2)),
          message: `Uploading to BlackBox FTPS (${Math.round(ratio * 100)}%)...`,
        });
      });

      await client.uploadFrom(outputPath, outputFileName);
    } finally {
      client.close();
    }

    setJobStatus(jobId, {
      status: 'completed',
      progress: 1.0,
      message: `Uploaded ${outputFileName} to BlackBox!`,
      remoteFileName: outputFileName,
    });

    res.json({
      ok: true,
      remoteFileName: outputFileName,
      message: `Uploaded ${outputFileName} to ${
        ftpConfig.host || 'portal.blackbox.global'
      }`,
    });
  } catch (err) {
    setJobStatus(jobId, {
      status: 'error',
      progress: 0,
      message: err.message,
    });
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  } finally {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
      if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    } catch {}
  }
});

// Process-only endpoint for "Save to Device (Export)" without FTPS upload
app.post('/api/process-only', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ ok: false, error: 'No video file received.' });
  }

  const jobId = req.body.jobId || `job_${Date.now()}`;
  const originalName = req.body.originalName || file.originalname || 'clip.mov';
  let edits = {};
  let clientMetadata = {};

  try {
    edits = JSON.parse(req.body.edits || '{}');
    clientMetadata = JSON.parse(req.body.metadata || '{}');
  } catch {
    return res.status(400).json({ ok: false, error: 'Invalid JSON parameters.' });
  }

  const probed = probeMediaFile(file.path) || clientMetadata;
  const baseName = path
    .basename(originalName, path.extname(originalName))
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetFps = edits.targetFps || 30;
  const outputFileName = `${baseName}_BB_${targetFps}fps_CFR_${Date.now()
    .toString()
    .slice(-4)}.mp4`;
  const outputPath = path.join(workDir, outputFileName);

  const speedMult = edits.speedPct
    ? Number(edits.speedPct) / 100
    : Number(edits.speed || 1);
  const expectedOutDuration = Math.max(
    1,
    ((edits.trimEnd || 10) - (edits.trimStart || 0)) / speedMult
  );

  setJobStatus(jobId, {
    status: 'encoding',
    progress: 0.25,
    message: `Exporting ${targetFps}fps Rec.709 Master...`,
  });

  try {
    await new Promise((resolve, reject) => {
      const ffmpegArgs = buildFfmpegArgsServer(
        file.path,
        outputPath,
        edits,
        probed
      );
      const proc = spawn(ffmpegPath, ffmpegArgs);
      let stderrLog = '';

      proc.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrLog += text;
        const timeMatch = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const secs =
            parseInt(timeMatch[1], 10) * 3600 +
            parseInt(timeMatch[2], 10) * 60 +
            parseFloat(timeMatch[3]);
          const encodeRatio = Math.min(1, secs / expectedOutDuration);
          setJobStatus(jobId, {
            status: 'encoding',
            progress: Number((0.25 + encodeRatio * 0.7).toFixed(2)),
            message: `Exporting ${targetFps}fps CFR (${Math.round(
              encodeRatio * 100
            )}%)...`,
          });
        }
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(
            new Error(`FFmpeg exited with code ${code}: ${stderrLog.slice(-300)}`)
          );
      });

      proc.on('error', reject);
    });

    setJobStatus(jobId, {
      status: 'completed',
      progress: 1.0,
      message: `Exported ${outputFileName}`,
      fileName: outputFileName,
    });

    // Clean up exported file after 15 minutes
    setTimeout(() => {
      try {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
      } catch {}
    }, 15 * 60 * 1000);

    res.json({
      ok: true,
      fileName: outputFileName,
      downloadUrl: `/api/download/${encodeURIComponent(outputFileName)}`,
    });
  } catch (err) {
    setJobStatus(jobId, {
      status: 'error',
      progress: 0,
      message: err.message,
    });
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  } finally {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch {}
  }
});

app.get('/api/download/:fileName', (req, res) => {
  const safeName = path.basename(req.params.fileName || '');
  const resolvedWorkDir = path.resolve(workDir);
  const resolvedFilePath = path.resolve(workDir, safeName);

  // Prevent path traversal outside workDir
  if (
    !safeName ||
    !resolvedFilePath.startsWith(resolvedWorkDir) ||
    !fs.existsSync(resolvedFilePath)
  ) {
    return res.status(404).json({ ok: false, error: 'Exported file not found.' });
  }
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  const stream = fs.createReadStream(resolvedFilePath);
  stream.pipe(res);
});

const PORT = process.env.PORT || 4545;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    const ips = getLocalLanIps();
    console.log(`\n========================================================`);
    console.log(`🚀 BB Direct Studio Bridge running on port ${PORT}`);
    ips.forEach((ip) =>
      console.log(`📱 iPhone Connection URL: http://${ip}:${PORT}`)
    );
    console.log(`========================================================\n`);
  });
}

module.exports = { app, buildFfmpegArgsServer, probeMediaFile };
