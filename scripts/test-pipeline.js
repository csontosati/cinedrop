const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const { buildFfmpegArgsServer, probeMediaFile } = require('../server/index');

console.log('🧪 Running BlackBox Direct Studio Pipeline Verification...');

// 1. Generate a synthetic HLG HDR / 60fps test clip (12 seconds, 1920x1080)
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-test-'));
const inputVideo = path.join(tmpDir, 'iphone_raw_60fps_hlg.mp4');
const outputVideo = path.join(tmpDir, 'bb_compliant_30fps_rec709_cfr.mp4');

console.log('1️⃣ Creating synthetic iPhone 1080p 60fps HLG HDR video...');
const genRes = spawnSync(ffmpegPath, [
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=12:size=1920x1080:rate=60',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=12',
  '-c:v',
  'libx264',
  '-preset',
  'ultrafast',
  '-color_primaries',
  'bt2020',
  '-color_trc',
  'arib-std-b67',
  '-colorspace',
  'bt2020nc',
  '-c:a',
  'aac',
  inputVideo,
]);
assert.strictEqual(genRes.status, 0, 'Failed to generate synthetic input video');

// 1.5 Verify Automated Native Metadata Probe (probeMediaFile)
console.log('1.5️⃣ Probing native video metadata (FPS, Resolution, Color Transfer)...');
const probedMeta = probeMediaFile(inputVideo);
assert.strictEqual(probedMeta.fps, 60, `Expected probed FPS 60, got ${probedMeta.fps}`);
assert.strictEqual(probedMeta.width, 1920, 'Expected width 1920');
assert.strictEqual(probedMeta.height, 1080, 'Expected height 1080');
assert.strictEqual(probedMeta.colorTransfer, 'arib-std-b67', `Expected HLG colorTransfer, got ${probedMeta.colorTransfer}`);
assert.strictEqual(probedMeta.isHdrOrLog, true, 'Expected isHdrOrLog=true for HLG clip');
console.log(`   • Probed Metadata Badge: "${probedMeta.badge}"`);

// 2. Apply Edits: Trim 1.0s -> 4.5s (3.5s span), 50% Speed (0.5x Slow-Mo -> 7.0s output, compliant with 5-59s!),
//    Commercial Punch stock preset (+10% contrast, +15% saturation, 0.45 unsharp),
//    Rec.709 color normalization from HLG, 30fps Constant Frame Rate, Strip Audio = true
const edits = {
  trimStart: 1.0,
  trimEnd: 4.5,
  speed: 0.5,
  presetId: 'commercial_punch',
  exposure: 0.0,
  contrast: 1.1,
  saturation: 1.15,
  temperature: 0.0,
  sharpness: 0.45,
  targetFps: 30,
  resolution: 'source',
  stripAudio: true,
  normalizeToRec709: true,
  colorTransfer: probedMeta.colorTransfer,
  isHdrOrLog: probedMeta.isHdrOrLog,
};

console.log('2️⃣ Running FFmpeg Rec.709 Normalization + CFR + Slow-Mo + Stock Preset + CRF 16 pipeline...');
const ffmpegArgs = buildFfmpegArgsServer(inputVideo, outputVideo, edits);
const encodeRes = spawnSync(ffmpegPath, ffmpegArgs);
assert.strictEqual(
  encodeRes.status,
  0,
  `FFmpeg encoding failed: ${encodeRes.stderr?.toString()}`
);
assert.ok(fs.existsSync(outputVideo), 'Output CFR video file was not created');

// 3. Inspect output with ffprobe to verify Constant Frame Rate (30/1), Rec.709 color tags, High Profile, stripped audio, and ~7.0s duration
console.log('3️⃣ Inspecting output stream compliance with ffprobe...');
const probeRes = spawnSync(ffprobePath, [
  '-v',
  'error',
  '-show_entries',
  'stream=codec_type,profile,r_frame_rate,avg_frame_rate,width,height,color_space,color_primaries,color_transfer:format=duration',
  '-of',
  'json',
  outputVideo,
]);
const probeData = JSON.parse(probeRes.stdout.toString());

const videoStream = probeData.streams.find((s) => s.codec_type === 'video');
const audioStream = probeData.streams.find((s) => s.codec_type === 'audio');
const duration = parseFloat(probeData.format.duration);

assert.ok(videoStream, 'Missing video stream in output');
assert.strictEqual(audioStream, undefined, 'Audio stream should be stripped (-an)');
assert.strictEqual(videoStream.r_frame_rate, '30/1', 'Target frame rate must be 30/1 CFR');
assert.strictEqual(videoStream.color_space, 'bt709', 'Output color_space must be normalized to bt709');
assert.strictEqual(videoStream.color_primaries, 'bt709', 'Output color_primaries must be normalized to bt709');
assert.strictEqual(videoStream.color_transfer, 'bt709', 'Output color_transfer must be normalized to bt709');
assert.ok(
  duration >= 6.5 && duration <= 7.5,
  `Expected ~7.0s slow-motion duration, got ${duration}s`
);

// Clean up
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('✅ All BlackBox Global compliance checks passed!');
console.log(`   • Probed Input: ${probedMeta.badge}`);
console.log(`   • Output Duration: ${duration.toFixed(2)}s (within 5–59s BlackBox window)`);
console.log(`   • Frame Rate: ${videoStream.r_frame_rate} Constant Frame Rate (CFR)`);
console.log(`   • H.264 Profile: ${videoStream.profile} (CRF 16 Visually Lossless)`);
console.log(`   • Normalized Color Space: ${videoStream.color_space} / ${videoStream.color_primaries} / ${videoStream.color_transfer}`);
console.log(`   • Resolution: ${videoStream.width}x${videoStream.height}`);
console.log(`   • Audio Track: Stripped (Muted)`);
