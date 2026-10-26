import React, { useState, useEffect, useRef } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TouchableOpacity,
  SafeAreaView,
  ScrollView,
  Alert,
  Modal,
  Linking,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import * as ImagePicker from 'expo-image-picker';
import { useVideoPlayer, VideoView } from 'expo-video';
import Slider from '@react-native-community/slider';
import { Ionicons } from '@expo/vector-icons';
import {
  BlackBoxFtpConfig,
  ClipEditSettings,
  DEFAULT_EDIT_SETTINGS,
  pickTargetCfr,
  STOCK_PRESETS,
  StockPresetId,
  VideoClip,
} from './src/types/clip';
import { validateBlackBoxCompliance } from './src/utils/ffmpegBuilder';
import {
  DEFAULT_FTP_CONFIG,
  getDefaultBridgeUrl,
  loadFtpConfig,
  saveFtpConfig,
} from './src/services/storageService';
import { probeVideoMetadata } from './src/services/metadataProbe';
import { processAndUploadClip } from './src/services/processingEngine';
import { FtpSettingsModal } from './src/components/FtpSettingsModal';
import { BatchCarousel } from './src/components/BatchCarousel';

type BottomMode =
  | 'preset'
  | 'exposure'
  | 'temperature'
  | 'contrast'
  | 'saturation'
  | 'sharpness'
  | 'speedPct';

type NumericDialParam = Exclude<BottomMode, 'preset'>;

const DIAL_META: Record<
  NumericDialParam,
  {
    label: string;
    min: number;
    max: number;
    step: number;
    def: number;
    format: (v: number, srcFps?: number) => string;
  }
> = {
  exposure: {
    label: 'Light',
    min: -0.35,
    max: 0.35,
    step: 0.01,
    def: 0,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`,
  },
  temperature: {
    label: 'Warmth',
    min: -0.8,
    max: 0.8,
    step: 0.02,
    def: 0,
    format: (v) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`,
  },
  contrast: {
    label: 'Contrast',
    min: 0.65,
    max: 1.45,
    step: 0.01,
    def: 1.0,
    format: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`,
  },
  saturation: {
    label: 'Color',
    min: 0.0,
    max: 1.7,
    step: 0.02,
    def: 1.0,
    format: (v) => `${v >= 1 ? '+' : ''}${Math.round((v - 1) * 100)}%`,
  },
  sharpness: {
    label: 'Detail',
    min: 0.0,
    max: 1.5,
    step: 0.05,
    def: 0.15,
    format: (v) => `${Math.round(v * 100)}%`,
  },
  speedPct: {
    label: 'Speed',
    min: 20,
    max: 100,
    step: 1,
    def: 100,
    format: (v, srcFps = 60) => {
      const actualFps = Number(((srcFps * v) / 100).toFixed(2));
      const cfr = pickTargetCfr(actualFps, srcFps);
      if (actualFps < 23.5) {
        return `${Math.round(v)}% → ${actualFps} fps (<24 min)`;
      }
      return `${Math.round(v)}% → ${actualFps} fps (${cfr} CFR)`;
    },
  },
};

export default function App() {
  const [clips, setClips] = useState<VideoClip[]>([]);
  const [activeIdx, setActiveIdx] = useState<number>(0);
  const [activeMode, setActiveMode] = useState<BottomMode>('preset');
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [playheadSec, setPlayheadSec] = useState<number>(0);
  const [ftpConfig, setFtpConfig] = useState<BlackBoxFtpConfig>(DEFAULT_FTP_CONFIG);
  const [ftpModalVisible, setFtpModalVisible] = useState(false);
  const [sendSheetVisible, setSendSheetVisible] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [trimBoxWidth, setTrimBoxWidth] = useState<number>(220);
  const trimDragModeRef = useRef<'playhead' | 'start' | 'end' | null>(null);
  const [uploading, setUploading] = useState(false);
  const [toastText, setToastText] = useState<string | null>(null);
  const [appliedBanner, setAppliedBanner] = useState(false);
  const [deletedUndo, setDeletedUndo] = useState<{
    clip: VideoClip;
    index: number;
  } | null>(null);

  const undoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const swipeStartXRef = useRef<number | null>(null);

  useEffect(() => {
    loadFtpConfig().then(setFtpConfig);
  }, []);

  const currentClip = clips[activeIdx] || null;
  const edits =
    currentClip?.edits ||
    DEFAULT_EDIT_SETTINGS(12, 60, false);

  // Requirement 1: Static Preview by Default — paused at trimStart to eliminate CPU/GPU drain
  const player = useVideoPlayer(currentClip?.uri ?? null, (p) => {
    p.loop = false;
    p.muted = edits.stripAudio;
    p.playbackRate = edits.speedPct / 100;
    p.pause();
    p.currentTime = edits.trimStart;
  });

  // When switching clips in batch, keep playback paused at the new clip's trimStart poster frame
  useEffect(() => {
    setIsPlaying(false);
    if (!currentClip) return;
    setPlayheadSec(currentClip.edits.trimStart);
    if (!player) return;
    try {
      player.pause();
      player.muted = currentClip.edits.stripAudio;
      player.playbackRate = currentClip.edits.speedPct / 100;
      player.currentTime = currentClip.edits.trimStart;
    } catch {}
  }, [currentClip?.id]);

  useEffect(() => {
    if (!player || !currentClip) return;
    player.muted = currentClip.edits.stripAudio;
    player.playbackRate = currentClip.edits.speedPct / 100;
  }, [player, currentClip?.edits.stripAudio, currentClip?.edits.speedPct]);

  // Poll timeline bounds & update thin playhead while actively playing
  useEffect(() => {
    if (!currentClip || !player || !isPlaying) return;
    const interval = setInterval(() => {
      try {
        const pos = player.currentTime || 0;
        setPlayheadSec(pos);
        if (pos >= currentClip.edits.trimEnd) {
          player.pause();
          player.currentTime = currentClip.edits.trimStart;
          setPlayheadSec(currentClip.edits.trimStart);
          setIsPlaying(false);
        }
      } catch {}
    }, 150);
    return () => clearInterval(interval);
  }, [
    isPlaying,
    currentClip?.id,
    currentClip?.edits.trimStart,
    currentClip?.edits.trimEnd,
    player,
  ]);

  const togglePlayPause = () => {
    if (!player || !currentClip) return;
    try {
      if (isPlaying) {
        player.pause();
        setIsPlaying(false);
      } else {
        if (
          player.currentTime >= currentClip.edits.trimEnd - 0.1 ||
          player.currentTime < currentClip.edits.trimStart
        ) {
          player.currentTime = currentClip.edits.trimStart;
        }
        player.play();
        setIsPlaying(true);
      }
    } catch {}
  };

  // Seek directly to timestamp without initiating continuous playback
  const seekStaticFrame = (timestampSec: number) => {
    setPlayheadSec(timestampSec);
    if (!player) return;
    try {
      if (isPlaying) {
        player.pause();
        setIsPlaying(false);
      }
      player.currentTime = timestampSec;
    } catch {}
  };

  const updateCurrentEdits = (
    updater: (prev: ClipEditSettings) => ClipEditSettings
  ) => {
    if (!currentClip) return;
    setClips((prev) =>
      prev.map((c, idx) => {
        if (idx !== activeIdx) return c;
        const nextEdits = updater(c.edits);
        const effFps = (c.sourceFps * nextEdits.speedPct) / 100;
        return {
          ...c,
          status: 'ready',
          edits: {
            ...nextEdits,
            speed: Number((nextEdits.speedPct / 100).toFixed(3)),
            targetFps: pickTargetCfr(effFps, c.sourceFps),
          },
        };
      })
    );
  };

  const applyStockPreset = (presetId: Exclude<StockPresetId, 'custom'>) => {
    const found = STOCK_PRESETS.find((p) => p.id === presetId);
    if (!found) return;
    updateCurrentEdits((prev) => ({
      ...prev,
      preset: presetId,
      ...found.values,
    }));
  };

  const applyGradeToAll = () => {
    if (!currentClip || clips.length < 2) return;
    const src = currentClip.edits;
    setClips((prev) =>
      prev.map((c, idx) => {
        if (idx === activeIdx) return c;
        return {
          ...c,
          status: 'ready',
          edits: {
            ...c.edits,
            preset: src.preset,
            exposure: src.exposure,
            temperature: src.temperature,
            contrast: src.contrast,
            saturation: src.saturation,
            sharpness: src.sharpness,
            normalizeToRec709: src.normalizeToRec709,
          },
        };
      })
    );
  };

  const handleSplitClip = () => {
    if (!currentClip) return;
    const span = currentClip.edits.trimEnd - currentClip.edits.trimStart;
    if (span < 1.0) return;

    let splitAt = playheadSec;
    if (
      splitAt <= currentClip.edits.trimStart + 0.25 ||
      splitAt >= currentClip.edits.trimEnd - 0.25
    ) {
      splitAt = Number(
        (
          (currentClip.edits.trimStart + currentClip.edits.trimEnd) /
          2
        ).toFixed(2)
      );
    } else {
      splitAt = Number(splitAt.toFixed(2));
    }

    const originalEnd = currentClip.edits.trimEnd;
    const secondClip: VideoClip = {
      ...currentClip,
      id: `${Date.now()}_split_${Math.random().toString(36).slice(2, 6)}`,
      status: 'ready',
      progress: 0,
      edits: {
        ...currentClip.edits,
        trimStart: splitAt,
        trimEnd: originalEnd,
      },
    };

    setClips((prev) => {
      const updated = prev.map((c, i) =>
        i === activeIdx
          ? {
              ...c,
              status: 'ready' as const,
              edits: { ...c.edits, trimEnd: splitAt },
            }
          : c
      );
      updated.splice(activeIdx + 1, 0, secondClip);
      return updated;
    });
    setActiveIdx(activeIdx + 1);
    seekStaticFrame(splitAt);
  };

  const resetClipAt = (idx: number) => {
    setClips((prev) =>
      prev.map((c, i) =>
        i === idx
          ? {
              ...c,
              status: 'ready',
              edits: DEFAULT_EDIT_SETTINGS(
                c.sourceDuration,
                c.sourceFps,
                c.metadata.isHdrOrLog
              ),
            }
          : c
      )
    );
  };

  const handleSafeDeleteClip = (idx: number) => {
    const target = clips[idx];
    if (!target) return;

    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    setDeletedUndo({ clip: target, index: idx });

    setClips((prev) => {
      const next = prev.filter((_, i) => i !== idx);
      if (activeIdx >= next.length) {
        setActiveIdx(Math.max(0, next.length - 1));
      }
      return next;
    });

    undoTimeoutRef.current = setTimeout(() => {
      setDeletedUndo(null);
    }, 5000);
  };

  const handleUndoDelete = () => {
    if (!deletedUndo) return;
    if (undoTimeoutRef.current) clearTimeout(undoTimeoutRef.current);
    const { clip: restored, index } = deletedUndo;
    setDeletedUndo(null);
    setClips((prev) => {
      const copy = [...prev];
      const insertAt = Math.min(index, copy.length);
      copy.splice(insertAt, 0, restored);
      setActiveIdx(insertAt);
      return copy;
    });
  };

  // Requirement 2: Automated Native Video Metadata Extraction on file pick
  const pickVideos = async () => {
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!perm.granted) {
      Alert.alert(
        'Photos Access Needed',
        'Allow access to your Camera Roll to pick footage.'
      );
      return;
    }

    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['videos'],
      allowsMultipleSelection: true,
      quality: 1,
    });

    if (res.canceled || !res.assets?.length) return;

    const added: VideoClip[] = [];
    for (let i = 0; i < res.assets.length; i++) {
      const asset = res.assets[i];
      const durationSec = asset.duration ? asset.duration / 1000 : 12;
      const meta = await probeVideoMetadata({
        uri: asset.uri,
        width: asset.width,
        height: asset.height,
        durationSec,
        fileSize: asset.fileSize,
        bridgeUrl: ftpConfig.bridgeUrl,
      });

      added.push({
        id: `${Date.now()}_${i}`,
        uri: asset.uri,
        fileName: asset.fileName || `CLIP_${i + 1}.MOV`,
        sourceDuration: meta.duration,
        sourceFps: meta.fps,
        width: meta.width,
        height: meta.height,
        fileSize: asset.fileSize,
        metadata: meta,
        edits: DEFAULT_EDIT_SETTINGS(meta.duration, meta.fps, meta.isHdrOrLog),
        status: 'ready',
        progress: 0,
      });
    }

    setClips((prev) => {
      const firstNewIdx = prev.length;
      const combined = [...prev, ...added];
      setActiveIdx(firstNewIdx);
      return combined;
    });
  };

  const compliantClips = clips.filter(
    (c) =>
      validateBlackBoxCompliance(c.edits, c.width, c.height, c.sourceFps)
        .isValid
  );

  const openSendModal = () => {
    if (!clips.length) return;
    const nextSel: Record<string, boolean> = {};
    clips.forEach((c) => {
      nextSel[c.id] = selectedIds[c.id] !== undefined ? selectedIds[c.id] : true;
    });
    setSelectedIds(nextSel);
    setSendSheetVisible(true);
  };

  const selectedClips = clips.filter((c) => selectedIds[c.id] !== false);

  const handleExportToDevice = async () => {
    if (!selectedClips.length) return;
    setSendSheetVisible(false);

    if (isPlaying && player) {
      player.pause();
      setIsPlaying(false);
    }

    setUploading(true);
    try {
      const bridgeBase = (ftpConfig.bridgeUrl || getDefaultBridgeUrl()).replace(
        /\/+$/,
        ''
      );
      for (let i = 0; i < selectedClips.length; i++) {
        const target = selectedClips[i];
        setToastText(`Exporting ${target.edits.targetFps}fps CFR…`);
        const fd = new FormData();
        fd.append('jobId', `export_${Date.now()}_${i}`);
        fd.append('originalName', target.fileName);
        fd.append('edits', JSON.stringify(target.edits));
        fd.append('metadata', JSON.stringify(target.metadata || {}));
        fd.append('video', {
          uri: target.uri,
          name: target.fileName,
          type: 'video/quicktime',
        } as any);

        const res = await fetch(`${bridgeBase}/api/process-only`, {
          method: 'POST',
          body: fd,
        });
        const data = await res.json();
        if (!data.ok) {
          throw new Error(data.error || 'Export failed');
        }
        await Linking.openURL(`${bridgeBase}${data.downloadUrl}`);
      }
      setToastText(
        `Saved ${selectedClips.length} clip${selectedClips.length > 1 ? 's' : ''}`
      );
      setTimeout(() => setToastText(null), 3000);
    } catch (err: any) {
      Alert.alert('Export Failed', err?.message || 'Check bridge connection.');
      setToastText(null);
    } finally {
      setUploading(false);
    }
  };

  const handleBatchSend = async () => {
    if (!selectedClips.length) return;
    setSendSheetVisible(false);
    if (!ftpConfig.username || !ftpConfig.password) {
      setFtpModalVisible(true);
      return;
    }

    if (isPlaying && player) {
      player.pause();
      setIsPlaying(false);
    }

    setUploading(true);
    try {
      for (let i = 0; i < selectedClips.length; i++) {
        const target = selectedClips[i];
        const prefix =
          selectedClips.length > 1
            ? `[${i + 1}/${selectedClips.length}] `
            : '';
        setToastText(`${prefix}Encoding Rec.709 CFR… 0%`);

        await processAndUploadClip(target, ftpConfig, (u) => {
          setToastText(
            `${prefix}${u.message} (${Math.round(u.progress * 100)}%)`
          );
        });

        setClips((prev) =>
          prev.map((c) =>
            c.id === target.id ? { ...c, status: 'completed' } : c
          )
        );
      }

      setToastText(
        `Uploaded ${selectedClips.length} clip${
          selectedClips.length > 1 ? 's' : ''
        } to BlackBox`
      );
      setTimeout(() => setToastText(null), 3500);
    } catch (err: any) {
      Alert.alert('Upload Failed', err?.message || 'Check connection settings.');
      setToastText(null);
    } finally {
      setUploading(false);
    }
  };

  const sourceDuration = Math.max(currentClip?.sourceDuration || 12, 1);
  const compliance = validateBlackBoxCompliance(
    edits,
    currentClip?.width,
    currentClip?.height,
    currentClip?.sourceFps || 60
  );
  const canSend = compliantClips.length > 0 && !uploading;
  const currentDialMeta =
    activeMode !== 'preset' ? DIAL_META[activeMode] : null;

  // Live preview overlays simulating Rec.709 normalization + preset/slider look
  const getExposureTint = () => {
    if (edits.exposure > 0.01) {
      return {
        backgroundColor: `rgba(255,255,255,${Math.min(0.24, edits.exposure * 0.5)})`,
      };
    }
    if (edits.exposure < -0.01) {
      return {
        backgroundColor: `rgba(0,0,0,${Math.min(0.4, Math.abs(edits.exposure) * 0.7)})`,
      };
    }
    return null;
  };

  const getWarmthTint = () => {
    if (edits.temperature > 0.015) {
      return {
        backgroundColor: `rgba(255,152,48,${Math.min(0.2, edits.temperature * 0.22)})`,
      };
    }
    if (edits.temperature < -0.015) {
      return {
        backgroundColor: `rgba(56,152,255,${Math.min(0.2, Math.abs(edits.temperature) * 0.22)})`,
      };
    }
    return null;
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />

      {/* Top Functional Toolbar (Liquid Glass) */}
      <View style={styles.toolbar}>
        <TouchableOpacity
          style={styles.iconBtn}
          onPress={() => setFtpModalVisible(true)}
          accessibilityRole="button"
          accessibilityLabel="Account settings"
        >
          <Ionicons name="settings-outline" size={20} color="#F4F4F6" />
          <View
            style={[
              styles.statusDot,
              ftpConfig.username && ftpConfig.password
                ? styles.dotReady
                : styles.dotPending,
            ]}
          />
        </TouchableOpacity>

        {currentClip && (
          <View
            style={[
              styles.timecodePill,
              !compliance.isValid && styles.timecodePillInvalid,
            ]}
          >
            <Text
              style={[
                styles.timecodeText,
                !compliance.isValid && styles.timecodeTextInvalid,
              ]}
            >
              {!compliance.isValid
                ? compliance.outputDuration < 5
                  ? `${compliance.outputDuration.toFixed(1)}s · Min 5s`
                  : compliance.outputDuration > 59
                  ? `${compliance.outputDuration.toFixed(1)}s · Max 59s`
                  : `${compliance.effectiveFps} fps · Min 24 fps`
                : `${compliance.outputDuration.toFixed(1)}s · ${compliance.targetCfr} fps`}
            </Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.sendBtn, !canSend && styles.sendBtnDisabled]}
          disabled={!canSend}
          onPress={openSendModal}
          accessibilityRole="button"
          accessibilityLabel="Choose clips to export or send to BlackBox"
        >
          <Text
            style={[styles.sendBtnText, !canSend && styles.sendBtnTextDisabled]}
          >
            Send
          </Text>
          <Ionicons
            name="arrow-up"
            size={15}
            color={canSend ? '#121214' : '#52525B'}
          />
        </TouchableOpacity>
      </View>

      {/* Center Content Stage (Fits Clip Frame Aspect Ratio Without Extra Grey Box) */}
      <View
        style={styles.stage}
        onTouchStart={(e) => {
          swipeStartXRef.current = e.nativeEvent.pageX;
        }}
        onTouchEnd={(e) => {
          if (swipeStartXRef.current === null || clips.length < 2) return;
          const dx = e.nativeEvent.pageX - swipeStartXRef.current;
          swipeStartXRef.current = null;
          if (dx < -60 && activeIdx < clips.length - 1) {
            setActiveIdx(activeIdx + 1);
          } else if (dx > 60 && activeIdx > 0) {
            setActiveIdx(activeIdx - 1);
          }
        }}
      >
        {!currentClip ? (
          <TouchableOpacity style={styles.emptyPrompt} onPress={pickVideos}>
            <View style={styles.plusRing}>
              <Ionicons name="add" size={28} color="#F4F4F6" />
            </View>
            <Text style={styles.emptyTitle}>Select Clips</Text>
            <Text style={styles.emptySub}>
              Auto-detects true FPS & color space. Batch grade in Rec.709 and
              upload lossless CFR to BlackBox.
            </Text>
          </TouchableOpacity>
        ) : (
          <View
            style={[
              styles.videoWrapper,
              currentClip.width >= currentClip.height
                ? {
                    width: '100%',
                    aspectRatio:
                      (currentClip.width || 16) / (currentClip.height || 9),
                    maxHeight: '100%',
                  }
                : {
                    height: '100%',
                    aspectRatio:
                      (currentClip.width || 9) / (currentClip.height || 16),
                    maxWidth: '100%',
                  },
            ]}
          >
            <VideoView
              player={player}
              style={styles.video}
              contentFit="cover"
              nativeControls={false}
            />
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, getExposureTint()]}
            />
            <View
              pointerEvents="none"
              style={[StyleSheet.absoluteFill, getWarmthTint()]}
            />

            {/* Glanceable Automated Metadata Badge (Requirement 2) */}
            <View style={styles.metaBadge}>
              <Text style={styles.metaBadgeText}>
                {currentClip.metadata.badgeText}
                {currentClip.metadata.isHdrOrLog ? ' → Rec.709' : ''}
              </Text>
            </View>

            {/* Deliberate Play/Pause Control (44x44pt Apple HIG target, paused by default) */}
            <TouchableOpacity
              style={styles.playToggleBtn}
              onPress={togglePlayPause}
              accessibilityRole="button"
              accessibilityLabel={
                isPlaying ? 'Pause preview' : 'Play preview'
              }
            >
              <Ionicons
                name={isPlaying ? 'pause' : 'play'}
                size={20}
                color="#F4F4F6"
              />
            </TouchableOpacity>
          </View>
        )}
      </View>

      {/* Bottom Precision Deck */}
      {currentClip && (
        <View style={styles.deck}>
          {/* Requirement 3: Swipe-Based Batch Carousel without exposed 'X' buttons */}
          <BatchCarousel
            clips={clips}
            activeIdx={activeIdx}
            onSelectClip={setActiveIdx}
            onAddClips={pickVideos}
            onApplyGradeToAll={applyGradeToAll}
            onResetClip={resetClipAt}
            onDeleteClip={handleSafeDeleteClip}
            appliedBanner={appliedBanner}
          />

          {/* 1. Trim Scrubber Row (Seeks Static Frame on Drag) */}
          <View style={styles.trimRow}>
            <TouchableOpacity
              style={styles.miniBtn}
              onPress={() =>
                updateCurrentEdits((p) => ({ ...p, stripAudio: !p.stripAudio }))
              }
              accessibilityRole="button"
              accessibilityLabel={
                edits.stripAudio ? 'Unmute audio' : 'Mute audio'
              }
            >
              <Ionicons
                name={edits.stripAudio ? 'volume-mute' : 'volume-high'}
                size={18}
                color={edits.stripAudio ? '#9CA3AF' : '#F4F4F6'}
              />
            </TouchableOpacity>

            <View
              style={styles.trimBox}
              onLayout={(e) =>
                setTrimBoxWidth(Math.max(1, e.nativeEvent.layout.width))
              }
              onStartShouldSetResponder={() => true}
              onMoveShouldSetResponder={() => true}
              onResponderGrant={(e) => {
                const x = e.nativeEvent.locationX;
                const startX = (edits.trimStart / sourceDuration) * trimBoxWidth;
                const endX = (edits.trimEnd / sourceDuration) * trimBoxWidth;
                const playX = (playheadSec / sourceDuration) * trimBoxWidth;
                const dStart = Math.abs(x - startX);
                const dEnd = Math.abs(x - endX);
                const dPlay = Math.abs(x - playX);

                if (
                  dPlay <= 16 &&
                  playheadSec > edits.trimStart + 0.15 &&
                  playheadSec < edits.trimEnd - 0.15
                ) {
                  trimDragModeRef.current = 'playhead';
                } else if (dStart <= 18 && dStart <= dEnd) {
                  trimDragModeRef.current = 'start';
                } else if (dEnd <= 18) {
                  trimDragModeRef.current = 'end';
                } else {
                  trimDragModeRef.current = 'playhead';
                }

                const ratio = Math.max(0, Math.min(1, x / trimBoxWidth));
                const t = Number((ratio * sourceDuration).toFixed(2));
                if (trimDragModeRef.current === 'playhead') {
                  seekStaticFrame(
                    Math.max(edits.trimStart, Math.min(edits.trimEnd, t))
                  );
                }
              }}
              onResponderMove={(e) => {
                const x = e.nativeEvent.locationX;
                const ratio = Math.max(0, Math.min(1, x / trimBoxWidth));
                const t = Number((ratio * sourceDuration).toFixed(2));
                if (trimDragModeRef.current === 'start') {
                  const nextS = Number(
                    Math.max(0, Math.min(edits.trimEnd - 0.5, t)).toFixed(1)
                  );
                  updateCurrentEdits((p) => ({ ...p, trimStart: nextS }));
                  seekStaticFrame(nextS);
                } else if (trimDragModeRef.current === 'end') {
                  const nextE = Number(
                    Math.min(
                      sourceDuration,
                      Math.max(edits.trimStart + 0.5, t)
                    ).toFixed(1)
                  );
                  updateCurrentEdits((p) => ({ ...p, trimEnd: nextE }));
                  seekStaticFrame(nextE);
                } else {
                  const nextP = Math.max(
                    edits.trimStart,
                    Math.min(edits.trimEnd, t)
                  );
                  seekStaticFrame(nextP);
                }
              }}
              onResponderRelease={() => {
                trimDragModeRef.current = null;
              }}
            >
              {/* Active Trim Fill */}
              <View
                pointerEvents="none"
                style={[
                  styles.trimFill,
                  {
                    left: `${(edits.trimStart / sourceDuration) * 100}%`,
                    width: `${
                      ((edits.trimEnd - edits.trimStart) / sourceDuration) * 100
                    }%`,
                  },
                ]}
              />

              {/* Start & End Trim Handles */}
              <View
                pointerEvents="none"
                style={[
                  styles.trimHandle,
                  { left: `${(edits.trimStart / sourceDuration) * 100}%` },
                ]}
              />
              <View
                pointerEvents="none"
                style={[
                  styles.trimHandle,
                  {
                    left: `${(edits.trimEnd / sourceDuration) * 100}%`,
                    transform: [{ translateX: -12 }],
                  },
                ]}
              />

              {/* Independently Movable Thin Playhead Line */}
              <View
                pointerEvents="none"
                style={[
                  styles.playheadLine,
                  {
                    left: `${Math.max(
                      0,
                      Math.min(100, (playheadSec / sourceDuration) * 100)
                    )}%`,
                  },
                ]}
              >
                <View style={styles.playheadDot} />
              </View>
            </View>

            <TouchableOpacity
              style={styles.miniBtn}
              onPress={handleSplitClip}
              accessibilityRole="button"
              accessibilityLabel="Split clip at playhead"
            >
              <Ionicons name="cut-outline" size={17} color="#F4F4F6" />
            </TouchableOpacity>

            <TouchableOpacity
              style={styles.syncInlineBtn}
              onPress={applyGradeToAll}
              accessibilityRole="button"
              accessibilityLabel="Sync color look across all clips"
            >
              <Text style={styles.syncInlineText}>Sync</Text>
            </TouchableOpacity>
          </View>

          {/* 2. Stock Preset Strip OR Single Active Parameter Dial */}
          <View style={styles.activeDialArea}>
            {activeMode === 'preset' ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.presetScroll}
              >
                {STOCK_PRESETS.map((preset) => {
                  const selected = edits.preset === preset.id;
                  return (
                    <TouchableOpacity
                      key={preset.id}
                      style={[
                        styles.presetCard,
                        selected && styles.presetCardActive,
                      ]}
                      onPress={() => applyStockPreset(preset.id)}
                    >
                      <Text
                        style={[
                          styles.presetTitle,
                          selected && styles.presetTitleActive,
                        ]}
                      >
                        {preset.name}
                      </Text>
                      <Text style={styles.presetSub} numberOfLines={1}>
                        {preset.subtitle}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            ) : (
              currentDialMeta && (
                <View>
                  <View style={styles.dialHeader}>
                    <Text style={styles.dialName}>{currentDialMeta.label}</Text>
                    <TouchableOpacity
                      onPress={() =>
                        updateCurrentEdits((p) => ({
                          ...p,
                          [activeMode]: currentDialMeta.def,
                        }))
                      }
                      hitSlop={10}
                    >
                      <Text
                        style={[
                          styles.dialValue,
                          activeMode === 'speedPct' &&
                            compliance.effectiveFps < 23.5 &&
                            styles.dialValueWarn,
                        ]}
                      >
                        {currentDialMeta.format(
                          edits[activeMode],
                          currentClip.sourceFps
                        )}
                      </Text>
                    </TouchableOpacity>
                  </View>

                  <Slider
                    minimumValue={currentDialMeta.min}
                    maximumValue={currentDialMeta.max}
                    step={currentDialMeta.step}
                    value={edits[activeMode]}
                    minimumTrackTintColor="#F4F4F6"
                    maximumTrackTintColor="#2E2E35"
                    thumbTintColor="#FFFFFF"
                    onValueChange={(v) => {
                      let nextVal =
                        activeMode === 'speedPct'
                          ? Math.round(v)
                          : Number(v.toFixed(2));
                      if (activeMode === 'speedPct') {
                        for (const snap of [25, 40, 50, 80, 100]) {
                          if (Math.abs(nextVal - snap) <= 1) {
                            nextVal = snap;
                            break;
                          }
                        }
                      }
                      updateCurrentEdits((p) => ({
                        ...p,
                        preset:
                          activeMode === 'speedPct' ? p.preset : 'custom',
                        [activeMode]: nextVal,
                      }));
                    }}
                  />
                </View>
              )
            )}
          </View>

          {/* 3. Mode & Parameter Selector Strip (44pt touch height) */}
          <View style={styles.paramStrip}>
            {(
              [
                { id: 'preset', label: 'Presets' },
                { id: 'exposure', label: 'Light' },
                { id: 'temperature', label: 'Warmth' },
                { id: 'contrast', label: 'Contrast' },
                { id: 'saturation', label: 'Color' },
                { id: 'sharpness', label: 'Detail' },
                { id: 'speedPct', label: 'Speed' },
              ] as { id: BottomMode; label: string }[]
            ).map((item) => {
              const active = activeMode === item.id;
              const modified =
                item.id === 'preset'
                  ? edits.preset !== 'natural'
                  : Math.abs(edits[item.id] - DIAL_META[item.id].def) > 0.015;

              return (
                <TouchableOpacity
                  key={item.id}
                  style={[styles.paramPill, active && styles.paramPillActive]}
                  onPress={() => setActiveMode(item.id)}
                >
                  <Text
                    style={[
                      styles.paramPillText,
                      active && styles.paramPillTextActive,
                    ]}
                  >
                    {item.label}
                  </Text>
                  {modified && <View style={styles.modifiedDot} />}
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      )}

      {/* Undo Clip Removal Banner (per Apple HIG undo-and-redo.md) */}
      {deletedUndo && !toastText && (
        <View style={styles.undoBanner}>
          <Text style={styles.undoText} numberOfLines={1}>
            Removed {deletedUndo.clip.fileName}
          </Text>
          <TouchableOpacity
            style={styles.undoBtn}
            onPress={handleUndoDelete}
            hitSlop={10}
          >
            <Text style={styles.undoBtnText}>Undo</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Determinate Progress Toast */}
      {toastText && (
        <View style={styles.toast}>
          <Text style={styles.toastText}>{toastText}</Text>
        </View>
      )}

      {/* Choose Clips + Save to Device OR Send to BlackBox Sheet */}
      <Modal
        visible={sendSheetVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setSendSheetVisible(false)}
      >
        <TouchableOpacity
          style={styles.sendBackdrop}
          activeOpacity={1}
          onPress={() => setSendSheetVisible(false)}
        >
          <View style={styles.sendSheet}>
            <View style={styles.sendGrabber} />
            <View style={styles.sendHeader}>
              <Text style={styles.sendTitle}>Choose Clips</Text>
              <TouchableOpacity
                onPress={() => {
                  const allSelected = clips.every(
                    (c) => selectedIds[c.id] !== false
                  );
                  const next: Record<string, boolean> = {};
                  clips.forEach((c) => {
                    next[c.id] = !allSelected;
                  });
                  setSelectedIds(next);
                }}
              >
                <Text style={styles.sendSelectAll}>
                  {clips.every((c) => selectedIds[c.id] !== false)
                    ? 'Deselect All'
                    : 'Select All'}
                </Text>
              </TouchableOpacity>
            </View>

            <ScrollView style={styles.sendList}>
              {clips.map((c) => {
                const check = validateBlackBoxCompliance(
                  c.edits,
                  c.width,
                  c.height,
                  c.sourceFps
                );
                const checked = selectedIds[c.id] !== false;
                return (
                  <TouchableOpacity
                    key={c.id}
                    style={styles.sendItemRow}
                    onPress={() =>
                      setSelectedIds((prev) => ({
                        ...prev,
                        [c.id]: !checked,
                      }))
                    }
                  >
                    <View>
                      <Text style={styles.sendItemTitle}>
                        {check.outputDuration.toFixed(1)}s · {check.targetCfr}{' '}
                        fps
                      </Text>
                      <Text style={styles.sendItemSub}>
                        {c.edits.preset} · {c.edits.speedPct}% speed
                      </Text>
                    </View>
                    <Ionicons
                      name={checked ? 'checkmark-circle' : 'ellipse-outline'}
                      size={22}
                      color={checked ? '#F4F4F6' : '#52525B'}
                    />
                  </TouchableOpacity>
                );
              })}
            </ScrollView>

            <View style={styles.sendActionsRow}>
              <TouchableOpacity
                style={[
                  styles.sendActionSecondary,
                  !selectedClips.length && { opacity: 0.4 },
                ]}
                disabled={!selectedClips.length}
                onPress={handleExportToDevice}
              >
                <Ionicons name="download-outline" size={17} color="#F4F4F6" />
                <Text style={styles.sendActionSecondaryText}>
                  Save to Device
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.sendActionPrimary,
                  !selectedClips.length && { opacity: 0.4 },
                ]}
                disabled={!selectedClips.length}
                onPress={handleBatchSend}
              >
                <Ionicons name="arrow-up" size={17} color="#121214" />
                <Text style={styles.sendActionPrimaryText}>
                  Send to BlackBox
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Settings Half-Sheet */}
      <FtpSettingsModal
        visible={ftpModalVisible}
        config={ftpConfig}
        onClose={() => setFtpModalVisible(false)}
        onSave={async (updated) => {
          setFtpConfig(updated);
          await saveFtpConfig(updated);
          setFtpModalVisible(false);
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#18181B',
  },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 54,
  },
  iconBtn: {
    width: 44,
    height: 44, // 44x44pt Apple HIG minimum hit target
    borderRadius: 22,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  statusDot: {
    position: 'absolute',
    top: 9,
    right: 9,
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  dotReady: {
    backgroundColor: '#4ADE80',
  },
  dotPending: {
    backgroundColor: '#9CA3AF',
  },
  timecodePill: {
    paddingHorizontal: 13,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  timecodePillInvalid: {
    backgroundColor: 'rgba(248, 113, 113, 0.16)',
    borderColor: 'rgba(248, 113, 113, 0.45)',
  },
  timecodeText: {
    color: '#E4E4E7',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  timecodeTextInvalid: {
    color: '#F87171',
  },
  sendBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 44, // 44pt Apple HIG touch target
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: '#F4F4F6',
  },
  sendBtnDisabled: {
    backgroundColor: '#232328',
  },
  sendBtnText: {
    color: '#121214',
    fontSize: 14,
    fontWeight: '600',
  },
  sendBtnTextDisabled: {
    color: '#52525B',
  },
  stage: {
    flex: 1,
    marginHorizontal: 16,
    marginVertical: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyPrompt: {
    width: '100%',
    paddingVertical: 48,
    paddingHorizontal: 32,
    borderRadius: 16,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
  },
  plusRing: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#2E2E35',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyTitle: {
    color: '#F4F4F6',
    fontSize: 17,
    fontWeight: '600',
    marginBottom: 6,
  },
  emptySub: {
    color: '#A1A1AA',
    fontSize: 13,
    textAlign: 'center',
    maxWidth: 250,
    lineHeight: 18,
  },
  videoWrapper: {
    position: 'relative',
    borderRadius: 14,
    overflow: 'hidden',
    backgroundColor: '#000000',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  video: {
    width: '100%',
    height: '100%',
  },
  metaBadge: {
    position: 'absolute',
    top: 12,
    left: 12,
    backgroundColor: 'rgba(24, 24, 27, 0.78)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.14)',
  },
  metaBadgeText: {
    color: '#E4E4E7',
    fontSize: 11,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  playToggleBtn: {
    position: 'absolute',
    bottom: 12,
    right: 12,
    width: 44,
    height: 44, // 44x44pt Apple HIG touch target
    borderRadius: 22,
    backgroundColor: 'rgba(24, 24, 27, 0.78)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  deck: {
    paddingHorizontal: 16,
    paddingTop: 6,
    paddingBottom: 10,
    gap: 10,
  },
  trimRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniBtn: {
    width: 44,
    height: 44, // 44x44pt Apple HIG minimum hit target
    borderRadius: 22,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.09)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  trimBox: {
    flex: 1,
    height: 44,
    backgroundColor: '#232328',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
    justifyContent: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  trimFill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(244, 244, 246, 0.14)',
  },
  trimHandle: {
    position: 'absolute',
    top: 4,
    bottom: 4,
    width: 12,
    borderRadius: 4,
    backgroundColor: '#F4F4F6',
    zIndex: 3,
  },
  playheadLine: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: '#F4F4F6',
    borderRadius: 1,
    zIndex: 4,
  },
  playheadDot: {
    position: 'absolute',
    top: 2,
    left: -4,
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: '#F4F4F6',
  },
  syncInlineBtn: {
    height: 44,
    paddingHorizontal: 14,
    borderRadius: 22,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncInlineText: {
    color: '#F4F4F6',
    fontSize: 12,
    fontWeight: '600',
  },
  sendBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sendSheet: {
    backgroundColor: '#202024',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 32,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.22)',
  },
  sendGrabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#52525B',
    alignSelf: 'center',
    marginBottom: 14,
  },
  sendHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 14,
  },
  sendTitle: {
    color: '#F4F4F6',
    fontSize: 16,
    fontWeight: '600',
  },
  sendSelectAll: {
    color: '#F4F4F6',
    fontSize: 14,
    fontWeight: '600',
  },
  sendList: {
    maxHeight: 220,
    backgroundColor: '#2A2A30',
    borderRadius: 12,
    marginBottom: 14,
  },
  sendItemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.09)',
  },
  sendItemTitle: {
    color: '#F4F4F6',
    fontSize: 14,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  sendItemSub: {
    color: '#A1A1AA',
    fontSize: 12,
    textTransform: 'capitalize',
    marginTop: 2,
  },
  sendActionsRow: {
    flexDirection: 'row',
    gap: 10,
  },
  sendActionSecondary: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#2A2A30',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sendActionSecondaryText: {
    color: '#F4F4F6',
    fontSize: 14,
    fontWeight: '600',
  },
  sendActionPrimary: {
    flex: 1,
    minHeight: 48,
    borderRadius: 12,
    backgroundColor: '#F4F4F6',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  sendActionPrimaryText: {
    color: '#121214',
    fontSize: 14,
    fontWeight: '600',
  },
  trimSlider: {
    flex: 1,
    height: 36,
  },
  activeDialArea: {
    height: 58,
    justifyContent: 'center',
  },
  presetScroll: {
    gap: 8,
    alignItems: 'center',
  },
  presetCard: {
    minHeight: 48,
    paddingHorizontal: 13,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: '#232328',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    justifyContent: 'center',
  },
  presetCardActive: {
    backgroundColor: '#2E2E35',
    borderColor: '#F4F4F6',
  },
  presetTitle: {
    color: '#D4D4D8',
    fontSize: 13,
    fontWeight: '600',
  },
  presetTitleActive: {
    color: '#F4F4F6',
  },
  presetSub: {
    color: '#A1A1AA',
    fontSize: 11, // Minimum 11pt per Apple HIG typography.md
    marginTop: 2,
  },
  dialHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 2,
  },
  dialName: {
    color: '#A1A1AA',
    fontSize: 12,
    fontWeight: '500',
  },
  dialValue: {
    color: '#F4F4F6',
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  dialValueWarn: {
    color: '#F87171',
  },
  paramStrip: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 4,
  },
  paramPill: {
    flex: 1,
    minHeight: 44, // 44pt minimum touch height per Apple HIG
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  paramPillActive: {
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  paramPillText: {
    color: '#A1A1AA',
    fontSize: 11, // Minimum 11pt per Apple HIG typography.md
    fontWeight: '500',
  },
  paramPillTextActive: {
    color: '#F4F4F6',
    fontWeight: '600',
  },
  modifiedDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#F4F4F6',
    position: 'absolute',
    bottom: 5,
  },
  undoBanner: {
    position: 'absolute',
    bottom: 24,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(35, 35, 40, 0.94)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  undoText: {
    color: '#E4E4E7',
    fontSize: 13,
    flex: 1,
    marginRight: 12,
  },
  undoBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
    backgroundColor: '#F4F4F6',
  },
  undoBtnText: {
    color: '#121214',
    fontSize: 13,
    fontWeight: '600',
  },
  toast: {
    position: 'absolute',
    bottom: 24,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(35, 35, 40, 0.94)',
    borderRadius: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  toastText: {
    color: '#F4F4F6',
    fontSize: 13,
    fontWeight: '500',
  },
});
