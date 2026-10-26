import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActionSheetIOS,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { VideoClip } from '../types/clip';
import { validateBlackBoxCompliance } from '../utils/ffmpegBuilder';

interface Props {
  clips: VideoClip[];
  activeIdx: number;
  onSelectClip: (index: number) => void;
  onAddClips: () => void;
  onApplyGradeToAll: () => void;
  onResetClip: (index: number) => void;
  onDeleteClip: (index: number) => void;
  appliedBanner: boolean;
}

export const BatchCarousel: React.FC<Props> = ({
  clips,
  activeIdx,
  onSelectClip,
  onAddClips,
  onApplyGradeToAll,
  onResetClip,
  onDeleteClip,
  appliedBanner,
}) => {
  const [sheetClipIdx, setSheetClipIdx] = useState<number | null>(null);

  const handleLongPressClip = (idx: number) => {
    const clip = clips[idx];
    if (!clip) return;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          title: `${clip.fileName} (${clip.metadata.badgeText})`,
          options: [
            'Remove Clip from Queue',
            'Reset Clip Adjustments',
            'Apply Grade to All Clips',
            'Cancel',
          ],
          destructiveButtonIndex: 0,
          cancelButtonIndex: 3,
          userInterfaceStyle: 'dark',
        },
        (buttonIndex) => {
          if (buttonIndex === 0) onDeleteClip(idx);
          else if (buttonIndex === 1) onResetClip(idx);
          else if (buttonIndex === 2) onApplyGradeToAll();
        }
      );
    } else {
      setSheetClipIdx(idx);
    }
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={clips}
        horizontal
        showsHorizontalScrollIndicator={false}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.listContent}
        renderItem={({ item, index }) => {
          const check = validateBlackBoxCompliance(
            item.edits,
            item.width,
            item.height,
            item.sourceFps
          );
          const isSelected = index === activeIdx;
          const isDone = item.status === 'completed';

          return (
            <TouchableOpacity
              style={[
                styles.card,
                isSelected && styles.cardActive,
                isDone && styles.cardDone,
                !check.isValid && styles.cardInvalid,
              ]}
              activeOpacity={0.75}
              onPress={() => onSelectClip(index)}
              onLongPress={() => handleLongPressClip(index)}
              delayLongPress={320}
              accessibilityRole="button"
              accessibilityLabel={`${check.outputDuration.toFixed(
                1
              )} seconds, ${check.targetCfr} frames per second. Hold for options.`}
            >
              <View style={styles.cardTopRow}>
                <Text
                  style={[
                    styles.clipDuration,
                    isSelected && styles.clipDurationActive,
                    !check.isValid && styles.textInvalid,
                  ]}
                >
                  {check.outputDuration.toFixed(1)}s
                </Text>
                {isDone && (
                  <Ionicons name="checkmark-circle" size={14} color="#4ADE80" />
                )}
              </View>
              <Text style={styles.clipSub} numberOfLines={1}>
                {check.targetCfr} fps · {item.edits.preset}
              </Text>
            </TouchableOpacity>
          );
        }}
        ListFooterComponent={
          <TouchableOpacity
            style={styles.addBtn}
            onPress={onAddClips}
            accessibilityRole="button"
            accessibilityLabel="Add more clips to batch"
          >
            <Ionicons name="add" size={20} color="#F4F4F6" />
          </TouchableOpacity>
        }
      />

      {/* Cross-Platform HIG Action Sheet Fallback (Long-press to remove clip) */}
      <Modal
        visible={sheetClipIdx !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setSheetClipIdx(null)}
      >
        <TouchableOpacity
          style={styles.sheetBackdrop}
          activeOpacity={1}
          onPress={() => setSheetClipIdx(null)}
        >
          <View style={styles.actionSheet}>
            <View style={styles.actionGroup}>
              <Text style={styles.actionTitle} numberOfLines={1}>
                {sheetClipIdx !== null && clips[sheetClipIdx]
                  ? `${clips[sheetClipIdx].fileName} (${clips[sheetClipIdx].metadata.badgeText})`
                  : 'Clip Options'}
              </Text>

              {/* Destructive choice at top per action-sheets.md */}
              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const target = sheetClipIdx;
                  setSheetClipIdx(null);
                  if (target !== null) onDeleteClip(target);
                }}
              >
                <Text style={styles.destructiveText}>
                  Remove Clip from Queue
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={styles.actionRow}
                onPress={() => {
                  const target = sheetClipIdx;
                  setSheetClipIdx(null);
                  if (target !== null) onResetClip(target);
                }}
              >
                <Text style={styles.actionText}>Reset Clip Adjustments</Text>
              </TouchableOpacity>

              {clips.length > 1 && (
                <TouchableOpacity
                  style={[styles.actionRow, { borderBottomWidth: 0 }]}
                  onPress={() => {
                    setSheetClipIdx(null);
                    onApplyGradeToAll();
                  }}
                >
                  <Text style={styles.actionText}>
                    Apply Grade to All Clips
                  </Text>
                </TouchableOpacity>
              )}
            </View>

            <TouchableOpacity
              style={styles.cancelRow}
              onPress={() => setSheetClipIdx(null)}
            >
              <Text style={styles.cancelText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
};

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  listContent: {
    gap: 8,
    paddingVertical: 2,
    alignItems: 'center',
  },
  card: {
    minWidth: 86,
    minHeight: 44, // Strict 44x44pt minimum touch target per Apple HIG
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#232328',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.09)',
    justifyContent: 'center',
  },
  cardActive: {
    backgroundColor: '#2E2E35',
    borderColor: '#F4F4F6',
  },
  cardDone: {
    borderColor: 'rgba(74, 222, 128, 0.45)',
  },
  cardInvalid: {
    borderColor: 'rgba(248, 113, 113, 0.45)',
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 6,
  },
  clipDuration: {
    color: '#D4D4D8',
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  clipDurationActive: {
    color: '#F4F4F6',
  },
  textInvalid: {
    color: '#F87171',
  },
  clipSub: {
    color: '#A1A1AA',
    fontSize: 11, // Minimum 11pt per Apple HIG typography.md
    marginTop: 2,
    textTransform: 'capitalize',
    fontVariant: ['tabular-nums'],
  },
  addBtn: {
    width: 44,
    height: 44, // 44x44pt Apple HIG touch target
    borderRadius: 10,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  syncAllBtn: {
    minHeight: 40,
    paddingHorizontal: 14,
    borderRadius: 10,
    backgroundColor: '#232328',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 255, 255, 0.22)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    transform: [{ translateY: -7 }],
  },
  syncAllText: {
    color: '#F4F4F6',
    fontSize: 12,
    fontWeight: '600',
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    justifyContent: 'flex-end',
    padding: 12,
    paddingBottom: 28,
  },
  actionSheet: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    gap: 8,
  },
  actionGroup: {
    backgroundColor: '#252529',
    borderRadius: 14,
    overflow: 'hidden',
  },
  actionTitle: {
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '500',
    textAlign: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  actionRow: {
    minHeight: 52,
    alignItems: 'center',
    justifyContent: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  destructiveText: {
    color: '#F87171',
    fontSize: 17,
    fontWeight: '600',
  },
  actionText: {
    color: '#F4F4F6',
    fontSize: 17,
    fontWeight: '400',
  },
  cancelRow: {
    minHeight: 52,
    backgroundColor: '#2C2C31',
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelText: {
    color: '#F4F4F6',
    fontSize: 17,
    fontWeight: '600',
  },
});
