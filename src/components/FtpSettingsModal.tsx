import React, { useState, useEffect } from 'react';
import {
  Modal,
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
  ActivityIndicator,
} from 'react-native';
import { BlackBoxFtpConfig } from '../types/clip';
import { testBlackBoxFtpConnection } from '../services/processingEngine';

interface Props {
  visible: boolean;
  config: BlackBoxFtpConfig;
  onClose: () => void;
  onSave: (updated: BlackBoxFtpConfig) => void;
}

export const FtpSettingsModal: React.FC<Props> = ({
  visible,
  config,
  onClose,
  onSave,
}) => {
  const [form, setForm] = useState<BlackBoxFtpConfig>(config);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    setForm(config);
    setTestResult(null);
  }, [config, visible]);

  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    const res = await testBlackBoxFtpConnection(form);
    setTestResult(res);
    setTesting(false);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet">
      <SafeAreaView style={styles.sheet}>
        <View style={styles.grabber} />

        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Text style={styles.cancelText}>Cancel</Text>
          </TouchableOpacity>
          <Text style={styles.title}>BlackBox FTPS</Text>
          <TouchableOpacity onPress={() => onSave(form)} hitSlop={12}>
            <Text style={styles.doneText}>Done</Text>
          </TouchableOpacity>
        </View>

        <View style={styles.body}>
          <View style={styles.group}>
            <View style={styles.row}>
              <Text style={styles.rowLabel}>Server</Text>
              <TextInput
                style={styles.rowInput}
                value={form.host}
                onChangeText={(v) => setForm({ ...form, host: v.trim() })}
                placeholder="portal.blackbox.global"
                placeholderTextColor="#52525B"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>Username</Text>
              <TextInput
                style={styles.rowInput}
                value={form.username}
                onChangeText={(v) => setForm({ ...form, username: v.trim() })}
                placeholder="FTP Username"
                placeholderTextColor="#52525B"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={[styles.row, styles.rowLast]}>
              <Text style={styles.rowLabel}>Password</Text>
              <TextInput
                style={styles.rowInput}
                value={form.password}
                onChangeText={(v) => setForm({ ...form, password: v })}
                placeholder="Required"
                placeholderTextColor="#52525B"
                secureTextEntry
                autoCapitalize="none"
              />
            </View>
          </View>

          <Text style={styles.sectionCaption}>PROCESSING BRIDGE</Text>
          <View style={styles.group}>
            <View style={[styles.row, styles.rowLast]}>
              <Text style={styles.rowLabel}>Host URL</Text>
              <TextInput
                style={styles.rowInput}
                value={form.bridgeUrl}
                onChangeText={(v) => setForm({ ...form, bridgeUrl: v.trim() })}
                placeholder="http://192.168.1.X:4545"
                placeholderTextColor="#52525B"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>
          </View>

          <TouchableOpacity
            style={styles.verifyRow}
            onPress={handleTest}
            disabled={testing}
          >
            {testing ? (
              <ActivityIndicator color="#F4F4F6" size="small" />
            ) : (
              <Text style={styles.verifyText}>Verify Connection</Text>
            )}
          </TouchableOpacity>

          {testResult && (
            <Text
              style={[
                styles.statusText,
                { color: testResult.ok ? '#4ADE80' : '#F87171' },
              ]}
            >
              {testResult.message}
            </Text>
          )}
        </View>
      </SafeAreaView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  sheet: {
    flex: 1,
    backgroundColor: '#202024',
  },
  grabber: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: '#52525B',
    alignSelf: 'center',
    marginTop: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  cancelText: {
    color: '#9CA3AF',
    fontSize: 16,
  },
  title: {
    color: '#F4F4F6',
    fontSize: 16,
    fontWeight: '600',
  },
  doneText: {
    color: '#F4F4F6',
    fontSize: 16,
    fontWeight: '600',
  },
  body: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  group: {
    backgroundColor: '#2A2A30',
    borderRadius: 12,
    overflow: 'hidden',
    marginBottom: 22,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    height: 46,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255, 255, 255, 0.08)',
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowLabel: {
    color: '#F4F4F6',
    fontSize: 15,
    width: 96,
  },
  rowInput: {
    flex: 1,
    color: '#F4F4F6',
    fontSize: 15,
    textAlign: 'right',
  },
  sectionCaption: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
    marginLeft: 12,
    marginBottom: 8,
    letterSpacing: 0.4,
  },
  verifyRow: {
    backgroundColor: '#2A2A30',
    borderRadius: 12,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
  },
  verifyText: {
    color: '#F4F4F6',
    fontSize: 15,
    fontWeight: '600',
  },
  statusText: {
    fontSize: 13,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 18,
  },
});
