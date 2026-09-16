interface MediaDevices {
  selectAudioOutput(options?: { deviceId?: string }): Promise<MediaDeviceInfo>;
}

interface AudioContext {
  setSinkId(sinkId: string): Promise<void>;
}
