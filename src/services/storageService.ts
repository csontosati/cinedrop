import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { BlackBoxFtpConfig } from '../types/clip';

const FTP_CONFIG_KEY = 'bb_direct_ftp_config_v1';

export function getDefaultBridgeUrl(): string {
  // Automatically detect the host IP running Expo so the iPhone connects with zero manual typing
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri && !hostUri.includes('exp.direct')) {
    const ip = hostUri.split(':')[0];
    if (ip && ip !== 'localhost') {
      return `http://${ip}:4545`;
    }
  }
  return 'http://localhost:4545';
}

export const DEFAULT_FTP_CONFIG: BlackBoxFtpConfig = {
  host: 'portal.blackbox.global',
  port: 21,
  username: '',
  password: '',
  remoteDir: '/',
  secure: true,
  bridgeUrl: getDefaultBridgeUrl(),
  executionMode: 'bridge',
};

export async function loadFtpConfig(): Promise<BlackBoxFtpConfig> {
  try {
    let raw: string | null = null;
    if (Platform.OS !== 'web') {
      raw = await SecureStore.getItemAsync(FTP_CONFIG_KEY);
    } else {
      raw = await AsyncStorage.getItem(FTP_CONFIG_KEY);
    }
    if (!raw) {
      return {
        ...DEFAULT_FTP_CONFIG,
        bridgeUrl: getDefaultBridgeUrl(),
      };
    }
    const parsed = JSON.parse(raw) as Partial<BlackBoxFtpConfig>;
    return {
      ...DEFAULT_FTP_CONFIG,
      ...parsed,
      bridgeUrl: parsed.bridgeUrl || getDefaultBridgeUrl(),
    };
  } catch {
    return {
      ...DEFAULT_FTP_CONFIG,
      bridgeUrl: getDefaultBridgeUrl(),
    };
  }
}

export async function saveFtpConfig(config: BlackBoxFtpConfig): Promise<void> {
  const serialized = JSON.stringify(config);
  if (Platform.OS !== 'web') {
    await SecureStore.setItemAsync(FTP_CONFIG_KEY, serialized);
  } else {
    await AsyncStorage.setItem(FTP_CONFIG_KEY, serialized);
  }
}
